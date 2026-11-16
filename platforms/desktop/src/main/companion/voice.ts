import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { getProfile, type VoiceSettings } from './db'
import { unloadAllModels } from './engine'
import { expandHome, LocalService } from './service'

export type VoiceRegister = 'normal' | 'excited'

// Long voice messages take about their own duration to synthesize.
const SYNTHESIS_TIMEOUT_MS = 180_000

/**
 * Local voice synthesis (Python service, see resources/companion-tts). Optional: it only
 * exists when profile.json has a `voice` section pointing to a Python env and a reference
 * recording — none of which live in this repo.
 */
class Voice {
	private readonly service = new LocalService('tts', 'companion-tts')

	settings(): VoiceSettings | null {
		const voice = getProfile().voice
		if (!voice) return null
		if (!existsSync(expandHome(voice.python)) || !existsSync(expandHome(voice.refs.normal.audio))) {
			console.warn('[companion:voice] voice configured but python or reference audio is missing')
			return null
		}
		return voice
	}

	isAvailable(): boolean {
		return this.settings() !== null
	}

	/** Starts the service if a voice is configured. The model itself loads on first use. */
	start(): void {
		const voice = this.settings()
		if (!voice || this.service.isRunning()) return
		this.service.start(expandHome(voice.python), {
			model: voice.model,
			refs: Object.fromEntries(Object.entries(voice.refs)
				.filter(([, r]) => r)
				.map(([name, r]) => [name, { audio: expandHome(r!.audio), text: r!.text }]))
		})
	}

	stop(): void {
		this.service.stop()
	}

	/** Synthesizes `text` into a new file of `outDir` (a conversation's media dir); returns its name and duration. */
	async synthesize(outDir: string, text: string, register: VoiceRegister): Promise<{ file: string; durationMs: number }> {
		this.start()
		// The LLM and the voice take turns on the GPU.
		await unloadAllModels()
		const file = `${randomUUID()}.ogg`
		const { durationMs } = await this.service.request<{ durationMs: number }>(
			'/synthesize', { text, register, out: path.join(outDir, file) }, SYNTHESIS_TIMEOUT_MS)
		return { file, durationMs }
	}
}

export const voice = new Voice()
