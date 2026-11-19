import { app, nativeImage } from 'electron'
import { copyFileSync, existsSync, linkSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { imageSpec, localEngine } from './engine'
import { importedPath } from './imports'

/**
 * `ai.image` (client docs/plan-ia-compagnon.md § 2.2, phase 1): an image from an image model the
 * hubby imported (a checkpoint), with LoRA it imported (of the checkpoint's family), on
 * stable-diffusion.cpp's server. **The safety negative is the platform's** (D5): added to every
 * image, whatever the hubby asks; and a prompt naming a minor is refused before anything runs.
 */

export interface ImageRequest {
	/** an imported checkpoint (its sha256) */
	checkpoint: string
	loras?: Array<{ lora: string, strength?: number }>
	prompt: string
	negative?: string
	width?: number
	height?: number
	steps?: number
	cfg?: number
	sampler?: string
	scheduler?: string
	/** a fixed seed (the same image again); none: random */
	seed?: number
	format?: 'jpeg' | 'png'
}

export interface ImageResult { image: string, width: number, height: number, seed: number | null, seconds: number }

export type ImageOutcome = { ok: true, result: ImageResult } | { ok: false, code: 'invalid' | 'refused' | 'unavailable' | 'failed', message: string }

const SAMPLERS = ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'dpm++2m_sde', 'er_sde', 'lms']
const SCHEDULERS = ['discrete', 'normal', 'karras', 'exponential', 'ays', 'gits', 'sgm_uniform', 'simple', 'smoothstep', 'kl_optimal', 'beta']

/** Always in the negative: no one in an image looks like a minor. */
export const SAFETY_NEGATIVE = 'child, children, kid, minor, underage, teen, teenager, adolescent, young girl, young boy, loli, shota, childlike, baby face, school uniform, petite child body'
/** A prompt asking for a minor is refused (whatever the negative). */
const MINOR = /\b(child|children|kids?|minors?|under ?age|teen(age|ager)?s?|adolescents?|pre ?teens?|loli|shota|jailbait|schoolgirls?|schoolboys?|(?:1[0-7]|[1-9]) ?(?:yo|y\/o|years? old)|young (girl|boy)s?|little (girl|boy)s?|enfants?|ado(lescent)?e?s?|mineure?s?|gamine?s?|fillette|petite fille)\b/i

const invalid = (message: string): ImageOutcome => ({ ok: false, code: 'invalid', message })
const int = (v: unknown, min: number, max: number, fallback: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? v as number : fallback

/** The LoRA folder sd-server reads: hard links named by sha256 (it ignores symbolic links; a copy across disks). */
function loraDir(): string {
	const dir = path.join(app.getPath('userData'), 'ai-image', 'loras')
	mkdirSync(dir, { recursive: true })
	return dir
}

function linkLora(dir: string, sha256: string, source: string): boolean {
	const at = path.join(dir, `${sha256}.safetensors`)
	if (existsSync(at)) return false
	try { linkSync(source, at) }
	catch { copyFileSync(source, at) }
	return true
}

export async function generateImage(hubby: string, request: unknown, signal: AbortSignal): Promise<ImageOutcome> {
	const r = request as Partial<ImageRequest> | null
	if (!r || typeof r !== 'object' || typeof r.checkpoint !== 'string' || typeof r.prompt !== 'string' || !r.prompt.trim()) return invalid('ai.image({ checkpoint, prompt, … })')
	if (r.prompt.length > 4_000 || (r.negative !== undefined && (typeof r.negative !== 'string' || r.negative.length > 4_000))) return invalid('prompt and negative: at most 4 000 characters')
	if (MINOR.test(r.prompt)) return { ok: false, code: 'refused', message: 'this prompt names a minor: refused' }
	const loras = Array.isArray(r.loras) ? r.loras : []
	if (loras.length > 8) return invalid('at most 8 LoRA')
	if (!localEngine.available()) return { ok: false, code: 'unavailable', message: 'the AI engine is not available on this device' }
	let checkpoint: ReturnType<typeof importedPath>
	let links: Array<{ sha256: string, path: string, strength: number }>
	try {
		checkpoint = importedPath(hubby, r.checkpoint, 'checkpoint')
		links = loras.map(l => {
			const found = importedPath(hubby, String(l?.lora ?? ''), 'lora')
			if (found.file.family !== 'unknown' && checkpoint.file.family !== 'unknown' && found.file.family !== checkpoint.file.family) {
				throw new Error(`${found.file.name} is a ${found.file.family} LoRA, ${checkpoint.file.name} a ${checkpoint.file.family} model`)
			}
			const strength = typeof l?.strength === 'number' && l.strength >= -2 && l.strength <= 2 ? l.strength : 0.8
			return { sha256: found.file.sha256, path: found.path, strength }
		})
	}
	catch (err) {
		return invalid(err instanceof Error ? err.message : String(err))
	}
	const sampler = SAMPLERS.includes(String(r.sampler)) ? String(r.sampler) : 'dpm++2m_sde'
	const scheduler = SCHEDULERS.includes(String(r.scheduler)) ? String(r.scheduler) : 'karras'
	const width = Math.round(int(r.width, 256, 1536, 832) / 64) * 64
	const height = Math.round(int(r.height, 256, 1536, 1216) / 64) * 64
	const seed = Number.isInteger(r.seed) && (r.seed as number) >= 0 ? r.seed as number : null
	const body = {
		prompt: r.prompt,
		negative_prompt: [r.negative?.trim(), SAFETY_NEGATIVE].filter(Boolean).join(', '),
		width, height,
		steps: int(r.steps, 1, 60, 30),
		cfg_scale: typeof r.cfg === 'number' && r.cfg >= 1 && r.cfg <= 15 ? r.cfg : 5,
		seed: seed ?? -1,
		batch_size: 1,
		sampler_name: sampler,
		scheduler,
		lora: links.map(l => ({ path: `${l.sha256}.safetensors`, multiplier: l.strength }))
	}
	const dir = loraDir()
	const started = Date.now()
	try {
		return await localEngine.use(imageSpec(checkpoint.path, dir), async () => {
			// a LoRA new to the folder: the server rescans it
			const added = links.map(l => linkLora(dir, l.sha256, l.path)).some(Boolean)
			if (added) await localEngine.request('/sdcpp/v1/models/refresh', { method: 'POST' })
			const res = await localEngine.request('/sdapi/v1/txt2img', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
			const out = await res.json().catch(() => null) as { images?: string[], error?: string } | null
			if (!res.ok || !out?.images?.[0]) return { ok: false as const, code: 'failed' as const, message: `the image server answered ${res.status}: ${out?.error ?? 'no image'}` }
			const png = Buffer.from(out.images[0], 'base64')
			// JPEG by default (no metadata, ~10 times smaller)
			const image = r.format === 'png'
				? `data:image/png;base64,${png.toString('base64')}`
				: `data:image/jpeg;base64,${nativeImage.createFromBuffer(png).toJPEG(88).toString('base64')}`
			return { ok: true as const, result: { image, width, height, seed, seconds: Math.round((Date.now() - started) / 100) / 10 } }
		})
	}
	catch (err) {
		if (signal.aborted) return { ok: false, code: 'failed', message: 'aborted' }
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
}
