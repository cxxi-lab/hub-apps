import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { localEngine, voiceSpec } from './engine'
import { importedPath } from './imports'
import { modelFiles, modelPlans } from './models'

/**
 * `ai.speech` (client docs/plan-ia-compagnon.md § 2.5, phase 1): speech in a voice — a voice model the
 * hubby declares (its hubby.json "ai", family voice: Qwen3-TTS, its talker and its codec), conditioned
 * by a sample the hubby imported (a WAV) and what that sample says, on qwentts.cpp's server. A fixed
 * seed per line keeps the voice even. The audio comes back as WAV (24 kHz mono).
 */

export interface SpeechRequest {
	/** a voice model the hubby declares */
	model: string
	/** an imported sample (its sha256) and its transcript */
	sample: string
	transcript: string
	text: string
	seed?: number
	temperature?: number
	language?: string
}

export interface SpeechResult { audio: string, seconds: number }

export type SpeechOutcome =
	| { ok: true, result: SpeechResult }
	| { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'failed', message: string }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const LANGUAGES = ['auto', 'French', 'English', 'German', 'Spanish', 'Italian', 'Portuguese', 'Russian', 'Chinese', 'Japanese', 'Korean']
const invalid = (message: string): SpeechOutcome => ({ ok: false, code: 'invalid', message })

// the voices registered on the running server (they live in its memory: a new process starts empty)
let registeredOn = -1
const registered = new Set<string>()

function wavSeconds(buf: Buffer): number {
	const byteRate = buf.readUInt32LE(28)
	let at = 12
	while (at + 8 <= buf.length) {
		const size = buf.readUInt32LE(at + 4)
		if (buf.toString('ascii', at, at + 4) === 'data') return byteRate ? Math.min(size, buf.length - at - 8) / byteRate : 0
		at += 8 + size + (size % 2)
	}
	return 0
}

export async function speak(hubby: string, request: unknown, signal: AbortSignal): Promise<SpeechOutcome> {
	const r = request as Partial<SpeechRequest> | null
	if (!r || typeof r !== 'object' || typeof r.model !== 'string' || !NAME.test(r.model) || typeof r.sample !== 'string' || typeof r.text !== 'string' || !r.text.trim()) {
		return invalid('ai.speech({ model, sample, transcript, text, … })')
	}
	if (r.text.length > 3_000) return invalid('text: at most 3 000 characters')
	if (typeof r.transcript !== 'string' || !r.transcript.trim() || r.transcript.length > 2_000) return invalid('transcript: what the sample says (at most 2 000 characters)')
	if (r.language !== undefined && !LANGUAGES.includes(r.language)) return invalid(`language: one of ${LANGUAGES.join(', ')}`)
	if (!localEngine.available()) return { ok: false, code: 'unavailable', message: 'the AI engine is not available on this device' }
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === r.model)
	if (!plan || plan.invalid) return invalid(`${hubby} declares no model ${r.model} this device accepts`)
	if (plan.family !== 'voice') return invalid(`${r.model} is not a voice model`)
	if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${r.model} is too large for this device` }
	if (!plan.consented) return { ok: false, code: 'consent', message: `${r.model} is not allowed on this device yet` }
	const files = modelFiles(hubby, r.model)
	if (!files) return { ok: false, code: 'missing', message: `${r.model} is not downloaded yet` }
	// its codec (the tokenizer) beside the talker
	const codec = files.find(f => /tokenizer|codec/i.test(path.basename(f)))
	const talker = files.find(f => f !== codec)
	if (!codec || !talker) return invalid(`${r.model}: a voice model has a talker and a codec (its tokenizer)`)
	let sample: ReturnType<typeof importedPath>
	try { sample = importedPath(hubby, r.sample, 'audio') }
	catch (err) { return invalid(err instanceof Error ? err.message : String(err)) }
	const voice = `v${sample.file.sha256.slice(0, 24)}`
	try {
		return await localEngine.use(voiceSpec(talker, codec), async () => {
			if (registeredOn !== localEngine.generation()) { registered.clear(); registeredOn = localEngine.generation() }
			const key = `${voice}\n${r.transcript}`
			if (!registered.has(key)) {
				const wav = await readFile(sample.path)
				const res = await localEngine.request('/v1/audio/voices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: voice, ref_text: r.transcript, wav_b64: wav.toString('base64') }), signal })
				if (!res.ok) return { ok: false as const, code: 'failed' as const, message: `the voice server refused the sample (${res.status}): ${(await res.text()).slice(0, 200)}` }
				registered.add(key)
			}
			const body: Record<string, unknown> = { input: r.text, voice, response_format: 'wav' }
			if (Number.isInteger(r.seed) && (r.seed as number) >= 0) body.seed = r.seed
			if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) body.temperature = r.temperature
			if (r.language && r.language !== 'auto') body.language = r.language
			const res = await localEngine.request('/v1/audio/speech', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
			if (!res.ok) return { ok: false as const, code: 'failed' as const, message: `the voice server answered ${res.status}: ${(await res.text()).slice(0, 200)}` }
			const wav = Buffer.from(await res.arrayBuffer())
			return { ok: true as const, result: { audio: `data:audio/wav;base64,${wav.toString('base64')}`, seconds: Math.round(wavSeconds(wav) * 10) / 10 } }
		})
	}
	catch (err) {
		if (signal.aborted) return { ok: false, code: 'failed', message: 'aborted' }
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
}
