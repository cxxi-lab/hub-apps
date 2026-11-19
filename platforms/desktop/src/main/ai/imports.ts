import { app, BrowserWindow, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { modelEvents } from './models'

/**
 * Files the user imports for a hubby's AI (client docs/plan-ia-compagnon.md § 2.3, D2-D3): an image
 * model (a checkpoint), a LoRA, a voice sample — what Hugging Face doesn't hold (the user's own
 * checkpoints, the LoRA of a character, a recording). Picked by the user (a file dialog: that is the
 * consent), referenced where it is (a checkpoint is ~6.5 GB: not copied), known by its sha256; its
 * size and modification time checked before each use (changed: imported again). Usable by the hubby
 * that imported it; another one imports it too. A checkpoint's or a LoRA's family (SDXL, SD 1.x,
 * Flux) is read from its safetensors header: a LoRA runs on a checkpoint of its family only.
 */

export type ImportKind = 'checkpoint' | 'lora' | 'audio'
export type ImageFamily = 'sdxl' | 'sd1' | 'flux' | 'unknown'

export interface ImportedFile {
	sha256: string
	kind: ImportKind
	/** its file name (where it is stays on this device) */
	name: string
	size: number
	family: ImageFamily | null
	/** an audio sample's length, in seconds */
	seconds: number | null
	/** the hubbies that imported it */
	users: string[]
}

interface Stored extends ImportedFile { path: string, mtimeMs: number }

const SHA256 = /^[0-9a-f]{64}$/
const MAX_AUDIO = 20 * 2 ** 20
const MAX_HEADER = 100 * 2 ** 20
const file = () => path.join(app.getPath('userData'), 'ai-imports.json')

function read(): Record<string, Stored> {
	try { return JSON.parse(readFileSync(file(), 'utf8')) as Record<string, Stored> }
	catch { return {} }
}
function write(all: Record<string, Stored>): void {
	writeFileSync(file(), JSON.stringify(all, null, 2), { mode: 0o600 })
	modelEvents.emit('changed')
}

const strip = (s: Stored): ImportedFile => ({ sha256: s.sha256, kind: s.kind, name: s.name, size: s.size, family: s.family, seconds: s.seconds, users: s.users })

/** A safetensors file's tensor names and metadata (its JSON header). */
async function safetensorsHeader(at: string): Promise<{ keys: string[], meta: Record<string, string> }> {
	const fh = await fsp.open(at, 'r')
	try {
		const head = Buffer.alloc(8)
		await fh.read(head, 0, 8, 0)
		const n = Number(head.readBigUInt64LE(0))
		if (n <= 2 || n > MAX_HEADER) throw new Error('not a safetensors file')
		const json = Buffer.alloc(n)
		await fh.read(json, 0, n, 8)
		const parsed = JSON.parse(json.toString('utf8')) as Record<string, unknown>
		const meta = (parsed.__metadata__ ?? {}) as Record<string, string>
		return { keys: Object.keys(parsed).filter(k => k !== '__metadata__'), meta }
	}
	finally {
		await fh.close()
	}
}

/** The family of a checkpoint or a LoRA, from its tensors (and a LoRA's training metadata). */
export function familyOf(kind: 'checkpoint' | 'lora', keys: string[], meta: Record<string, string>): ImageFamily {
	const has = (prefix: string) => keys.some(k => k.startsWith(prefix))
	if (kind === 'checkpoint') {
		if (has('double_blocks.') || has('model.diffusion_model.double_blocks.')) return 'flux'
		if (has('conditioner.embedders.1.')) return 'sdxl'
		if (has('cond_stage_model.')) return 'sd1'
		return 'unknown'
	}
	const base = `${meta.ss_base_model_version ?? ''} ${meta['modelspec.architecture'] ?? ''}`.toLowerCase()
	if (/flux/.test(base) || has('lora_unet_double_blocks') || has('transformer.')) return 'flux'
	if (/sdxl|stable-diffusion-xl/.test(base) || has('lora_te2_') || has('lora_unet_input_blocks_4_1_transformer_blocks_1')) return 'sdxl'
	if (/sd_v1|sd1|stable-diffusion-v1/.test(base) || has('lora_te_')) return 'sd1'
	return 'unknown'
}

/** A WAV file's length (its RIFF header), or why it isn't one tts-server takes. */
function wavSeconds(buf: Buffer): number {
	if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('a voice sample is a WAV file')
	let at = 12
	let byteRate = 0
	while (at + 8 <= buf.length) {
		const id = buf.toString('ascii', at, at + 4)
		const size = buf.readUInt32LE(at + 4)
		if (id === 'fmt ') byteRate = buf.readUInt32LE(at + 16)
		if (id === 'data' && byteRate) return Math.round((size / byteRate) * 10) / 10
		at += 8 + size + (size % 2)
	}
	throw new Error('this WAV file has no sound')
}

async function sha256Of(at: string): Promise<string> {
	const hash = createHash('sha256')
	for await (const chunk of createReadStream(at)) hash.update(chunk as Buffer)
	return hash.digest('hex')
}

const FILTERS: Record<ImportKind, Electron.FileFilter[]> = {
	checkpoint: [{ name: 'Image model (safetensors)', extensions: ['safetensors'] }],
	lora: [{ name: 'LoRA (safetensors)', extensions: ['safetensors'] }],
	audio: [{ name: 'Voice sample (WAV)', extensions: ['wav'] }]
}

/** The user picks a file for `hubby` (null: cancelled); checked, known by its sha256. */
export async function importFile(hubby: string, kind: ImportKind, window: BrowserWindow | null): Promise<ImportedFile | null> {
	if (!FILTERS[kind]) throw new Error('kind: checkpoint, lora or audio')
	const title = kind === 'checkpoint' ? 'Import an image model' : kind === 'lora' ? 'Import a LoRA' : 'Import a voice sample'
	// development: <userData>/ai-import-next holds the path a test picks (read once, then gone)
	const next = path.join(app.getPath('userData'), 'ai-import-next')
	let at: string | undefined
	if (!app.isPackaged && existsSync(next)) {
		at = readFileSync(next, 'utf8').trim()
		await fsp.rm(next, { force: true })
	}
	else {
		const picked = await (window ? dialog.showOpenDialog(window, { title, properties: ['openFile'], filters: FILTERS[kind] }) : dialog.showOpenDialog({ title, properties: ['openFile'], filters: FILTERS[kind] }))
		if (picked.canceled) return null
		at = picked.filePaths[0]
	}
	if (!at) return null
	const stat = statSync(at)
	let family: ImageFamily | null = null
	let seconds: number | null = null
	if (kind === 'audio') {
		if (stat.size > MAX_AUDIO) throw new Error('a voice sample is at most 20 MB')
		seconds = wavSeconds(await fsp.readFile(at))
	}
	else {
		const { keys, meta } = await safetensorsHeader(at)
		family = familyOf(kind, keys, meta)
		const looksLora = keys.some(k => /lora|\.alpha$/i.test(k))
		if (kind === 'checkpoint' && looksLora) throw new Error('this file is a LoRA, not an image model')
		if (kind === 'lora' && !looksLora) throw new Error('this file is not a LoRA')
	}
	console.log(`[ai:imports] ${hubby}: hashing ${path.basename(at)} (${(stat.size / 2 ** 30).toFixed(2)} GiB)`)
	const sha256 = await sha256Of(at)
	const all = read()
	const before = all[sha256]
	all[sha256] = { sha256, kind, name: path.basename(at), size: stat.size, family, seconds, path: at, mtimeMs: stat.mtimeMs, users: [...new Set([...(before?.users ?? []), hubby])] }
	write(all)
	return strip(all[sha256])
}

/** The files `hubby` imported (every one for null: Settings). */
export function importedFiles(hubby: string | null): ImportedFile[] {
	return Object.values(read()).filter(s => hubby === null || s.users.includes(hubby)).map(strip)
}

/** Forgets a file (it stays where it is on the disk). */
export function forgetFile(sha256: string): void {
	if (!SHA256.test(sha256)) throw new Error('invalid file')
	const all = read()
	delete all[sha256]
	write(all)
}

/** Where `hubby`'s imported file is, if it may use it and it is still the same file. */
export function importedPath(hubby: string, sha256: string, kind: ImportKind): { path: string, file: ImportedFile } {
	const s = SHA256.test(sha256) ? read()[sha256] : undefined
	if (!s || !s.users.includes(hubby) || s.kind !== kind) throw new Error(`no ${kind} ${sha256.slice(0, 12)}… imported for ${hubby} on this device`)
	if (!existsSync(s.path)) throw new Error(`${s.name} is no longer at ${s.path}: import it again`)
	const stat = statSync(s.path)
	if (stat.size !== s.size || Math.abs(stat.mtimeMs - s.mtimeMs) > 1) throw new Error(`${s.name} changed since it was imported: import it again`)
	return { path: s.path, file: strip(s) }
}
