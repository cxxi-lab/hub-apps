import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'

import { getProfile, type ExtraLora, type PhotoSettings } from './db'
import type { PhotoLevel } from './photo-policy'
import { unloadAllModels } from './engine'
import { expandHome, LocalService } from './service'

// Includes ComfyUI's cold start, retries of the apparent-age check and GPU cool-downs.
const GENERATION_TIMEOUT_MS = 900_000

export interface PhotoResult {
	file: string
	tags: string[]
	matched: boolean
}

/**
 * Local photo generation (Python service driving ComfyUI, see resources/companion-photo).
 * Optional: it only exists when profile.json has a `photo` section — the ComfyUI install,
 * checkpoints, character description and LoRA all live outside this repo.
 */
class Photo {
	private readonly service = new LocalService('photo', 'companion-photo')

	settings(): PhotoSettings | null {
		const photo = getProfile().photo
		if (!photo) return null
		if (!existsSync(expandHome(photo.comfyPython)) || !existsSync(expandHome(photo.comfyDir))) {
			console.warn('[companion:photo] photo configured but ComfyUI is missing')
			return null
		}
		return photo
	}

	isAvailable(): boolean {
		return this.settings() !== null
	}

	/** Starts the service; ComfyUI itself only starts with the first photo. */
	start(): void {
		const photo = this.settings()
		if (!photo || this.service.isRunning()) return
		this.service.start(expandHome(photo.comfyPython), {
			...photo,
			comfyDir: expandHome(photo.comfyDir),
			comfyPython: expandHome(photo.comfyPython),
			insightfaceRoot: expandHome(photo.insightfaceRoot),
			faceRef: photo.faceRef ? expandHome(photo.faceRef) : undefined,
			taggerDir: photo.taggerDir ? expandHome(photo.taggerDir) : undefined
		})
	}

	stop(): void {
		this.service.stop()
	}

	/**
	 * Generates a photo of `scene` into `outDir` (a conversation's media dir).
	 * @param negative extra negative prompt for this photo only
	 * @param loras    concept LoRAs for this photo only
	 * @param expect   groups of tags the photo must show one of (checked when a tagger is set up)
	 * @returns the file name, the tags found on the photo (empty without tagger) and whether it shows what was expected
	 */
	async generate(outDir: string, scene: string, level: PhotoLevel, negative = '', loras: ExtraLora[] = [], expect: string[][] = []): Promise<PhotoResult> {
		this.start()
		// The LLM and the image model take turns on the GPU.
		await unloadAllModels()
		const file = `${randomUUID()}.jpg`
		const { tags = [], matched = true } = await this.service.request<{ tags?: string[]; matched?: boolean }>(
			'/generate', { scene, level, negative, loras, expect, out: path.join(outDir, file) }, GENERATION_TIMEOUT_MS)
		return { file, tags, matched }
	}
}

export const photo = new Photo()
