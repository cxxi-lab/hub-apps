import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import component from '../../../../ai-engine/component.json'

/**
 * The local AI engine, a component of the platform (platforms/ai-engine/README.md, client
 * docs/plan-ia-moteur.md): llama.cpp, stable-diffusion.cpp and qwentts.cpp servers on Vulkan. Not
 * in the AppImage, brought by no hubby: downloaded the first time a hubby needs it, kept in the
 * app's data, and used only if the archive's sha256 is the one this build pins (component.json).
 * Development: HUB_AI_ENGINE_DIR points at a folder holding bin/<server> (built locally).
 */

export type EngineServer = 'llama-server' | 'sd-server' | 'tts-server'

const PLATFORM = `${process.platform}-${process.arch}`

interface Pinned { asset: string, sha256: string }

const pinned: Pinned | null = (component.files as Record<string, Pinned>)[PLATFORM] ?? null

const root = (): string => path.join(app.getPath('userData'), 'components', 'ai-engine')
const dir = (): string => process.env.HUB_AI_ENGINE_DIR ?? path.join(root(), `v${component.version}`)
const SERVERS: EngineServer[] = ['llama-server', 'sd-server', 'tts-server']

/** The pinned archive of this platform, if this build pins one (null: none published yet). */
function pin(): Pinned | null {
	return pinned && /^[0-9a-f]{64}$/.test(pinned.sha256) ? pinned : null
}

const marker = (): string => path.join(dir(), '.sha256')

/** The engine's folder if it is here and complete (its archive's sum recorded at install), or null. */
export function installedEngine(): string | null {
	if (process.env.HUB_AI_ENGINE_DIR) return existsSync(path.join(dir(), 'bin', 'llama-server')) ? dir() : null
	const wanted = pin()
	if (!wanted || !existsSync(marker())) return null
	if (readFileSync(marker(), 'utf8').trim() !== wanted.sha256 || SERVERS.some(s => !existsSync(path.join(dir(), 'bin', s)))) return null
	return dir()
}

/** A server's binary, if the engine is here. */
export function engineBinary(server: EngineServer): string | null {
	const here = installedEngine()
	return here ? path.join(here, 'bin', server) : null
}

/** Whether this build can bring the engine on this platform (it pins an archive for it). */
export const engineAvailable = (): boolean => !!process.env.HUB_AI_ENGINE_DIR || pin() !== null

function untar(archive: string, into: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('tar', ['-xzf', archive, '-C', into, '--no-same-owner'], err => err ? reject(err) : resolve())
	})
}

let downloading: Promise<string | null> | null = null

/**
 * The engine, downloaded if it isn't here (the other versions removed). Null: this build pins none
 * for this platform, or the download failed or doesn't match (never run then). `progress`: bytes
 * received / total (null: unknown).
 */
export function ensureEngine(progress?: (received: number, total: number | null) => void): Promise<string | null> {
	const here = installedEngine()
	if (here) return Promise.resolve(here)
	const wanted = pin()
	if (!wanted) return Promise.resolve(null)
	downloading ??= (async () => {
		const url = new URL(wanted.asset, component.url).href
		const staging = path.join(root(), `v${component.version}.part`)
		try {
			const response = await net.fetch(url)
			if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
			const total = Number(response.headers.get('content-length')) || null
			const hash = createHash('sha256')
			const chunks: Buffer[] = []
			let received = 0
			const reader = response.body.getReader()
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				const chunk = Buffer.from(value)
				hash.update(chunk)
				chunks.push(chunk)
				received += chunk.length
				progress?.(received, total)
			}
			const sum = hash.digest('hex')
			if (sum !== wanted.sha256) throw new Error(`sha256 ${sum}, expected ${wanted.sha256}`)
			await fsp.rm(root(), { recursive: true, force: true })
			await fsp.mkdir(staging, { recursive: true })
			const archive = path.join(root(), wanted.asset)
			await fsp.writeFile(archive, Buffer.concat(chunks))
			await untar(archive, staging)
			await fsp.rm(archive, { force: true })
			for (const server of SERVERS) {
				if (!existsSync(path.join(staging, 'bin', server))) throw new Error(`the archive has no bin/${server}`)
				await fsp.chmod(path.join(staging, 'bin', server), 0o755)
			}
			await fsp.writeFile(path.join(staging, '.sha256'), wanted.sha256)
			await fsp.rename(staging, dir())
			console.log(`[ai:engine] v${component.version} installed (${PLATFORM})`)
			return dir()
		}
		catch (err) {
			console.error(`[ai:engine] download of ${url} failed:`, err)
			await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
			return null
		}
		finally {
			downloading = null
		}
	})()
	return downloading
}

/** No installed hubby needs the engine any more: it goes. */
export function removeEngine(): void {
	if (process.env.HUB_AI_ENGINE_DIR || !existsSync(root())) return
	rmSync(root(), { recursive: true, force: true })
	console.log('[ai:engine] removed: no hubby needs it')
}
