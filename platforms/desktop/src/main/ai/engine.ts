import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import net from 'node:net'
import os from 'node:os'

import { engineAvailable, engineBinary, ensureEngine } from './component'
import { DEFAULT_LIMITS, holdGpu, releaseGpu, waitForCoolGpu } from './gpu'

/**
 * The local AI engine's text server (llama.cpp's llama-server, client docs/plan-ia-moteur.md § 4):
 * started when something needs a model, on the GPU with the most memory (a laptop's integrated GPU
 * also shows up), listening on 127.0.0.1 only with a token only this process knows, and stopped
 * after IDLE_MS without use (it holds the GPU's memory) or when the app quits. While it runs it
 * holds the GPU (its limits: ai/gpu.ts). The image and voice servers come with the companion's
 * chantier, on the same lifecycle.
 */

export type EngineStatus = 'off' | 'downloading' | 'starting' | 'on' | 'error'

export interface EngineInfo {
	status: EngineStatus
	/** the model it runs (a file), while starting or on */
	model: string | null
	/** the download, 0..1, while downloading (null: unknown size) */
	progress: number | null
	error: string | null
}

const IDLE_MS = Number(process.env.HUB_AI_ENGINE_IDLE_MS) || 5 * 60_000
const READY_TIMEOUT_MS = 180_000
const STOP_TIMEOUT_MS = 5_000
const GPU_OWNER = 'ai-engine'

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = net.createServer()
		srv.unref()
		srv.on('error', reject)
		srv.listen(0, '127.0.0.1', () => {
			const { port } = srv.address() as net.AddressInfo
			srv.close(() => resolve(port))
		})
	})
}

// a GPU with memory of its own, by its name; an integrated one shares the system's RAM (and reports
// a large share of it: a laptop's Iris Xe shows 16 GB on a 32 GB machine, more than its 8 GB RTX)
const DEDICATED = /NVIDIA|GeForce|Quadro|RTX|Radeon RX|Radeon Pro|Intel\(R\) Arc|\bArc\b/i
const SHARED_RAM_SHARE = 0.35

export interface GpuDevice { name: string, label: string, mib: number, dedicated: boolean }

/** The GPUs as llama.cpp lists them (`Vulkan1: NVIDIA … (8188 MiB, …)`), each dedicated or not. */
export function parseDevices(listing: string, totalMib = os.totalmem() / 2 ** 20): GpuDevice[] {
	const devices: GpuDevice[] = []
	for (const line of listing.split('\n')) {
		const m = /^\s*([A-Za-z]+\d+):\s*(.*?)\s*\((\d+) MiB/.exec(line)
		if (!m) continue
		const mib = Number(m[3])
		devices.push({ name: m[1], label: m[2], mib, dedicated: DEDICATED.test(m[2]) || mib < totalMib * SHARED_RAM_SHARE })
	}
	return devices
}

/** The dedicated GPU with the most memory, else the GPU with the most; null: none (the CPU then). */
export function pickDevice(devices: GpuDevice[]): GpuDevice | null {
	const byMemory = (a: GpuDevice, b: GpuDevice) => b.mib - a.mib
	return [...devices.filter(d => d.dedicated)].sort(byMemory)[0] ?? [...devices].sort(byMemory)[0] ?? null
}

function bestDevice(binary: string): Promise<string | null> {
	return new Promise(resolve => {
		execFile(binary, ['--list-devices'], { timeout: 20_000 }, (_err, stdout, stderr) => {
			const device = pickDevice(parseDevices(`${stdout}\n${stderr}`))
			if (device) console.log(`[ai:engine] device ${device.name}: ${device.label} (${device.mib} MiB${device.dedicated ? '' : ', shared'})`)
			resolve(device?.name ?? null)
		})
	})
}

export interface TextOptions {
	/** the context, in tokens */
	context?: number
}

class LocalEngine extends EventEmitter {
	private info: EngineInfo = { status: 'off', model: null, progress: null, error: null }
	private proc: ChildProcess | null = null
	private url: string | null = null
	private readonly token = randomBytes(24).toString('hex')
	private idle: NodeJS.Timeout | null = null
	private starting: Promise<void> | null = null

	getInfo(): EngineInfo {
		return { ...this.info }
	}

	/** Whether this build can bring the engine here. */
	available(): boolean {
		return engineAvailable()
	}

	private set(next: Partial<EngineInfo>): void {
		this.info = { ...this.info, ...next }
		this.emit('status', this.getInfo())
	}

	/** Keeps it running IDLE_MS more. */
	touch(): void {
		if (this.idle) clearTimeout(this.idle)
		this.idle = setTimeout(() => {
			console.log('[ai:engine] idle: stopped')
			void this.stop()
		}, IDLE_MS)
	}

	/** The text server running `model` (a GGUF file): started, or restarted on another model. */
	async text(model: string, options: TextOptions = {}): Promise<void> {
		if (this.info.status === 'on' && this.info.model === model) {
			this.touch()
			return
		}
		if (this.starting && this.info.model === model) return this.starting
		await this.stop()
		this.starting = this.start(model, options).finally(() => { this.starting = null })
		return this.starting
	}

	private async start(model: string, options: TextOptions): Promise<void> {
		if (!engineBinary('llama-server')) {
			this.set({ status: 'downloading', model, progress: null, error: null })
			let shown = -1
			const here = await ensureEngine((received, total) => {
				const percent = total ? Math.floor((received / total) * 100) : -1
				if (percent !== shown) { shown = percent; this.set({ progress: total ? received / total : null }) }
			})
			if (!here) {
				this.set({ status: 'error', progress: null, error: 'the engine could not be downloaded' })
				throw new Error('ai engine unavailable')
			}
		}
		const binary = engineBinary('llama-server')!
		this.set({ status: 'starting', model, progress: null, error: null })
		const [port, device] = await Promise.all([freePort(), bestDevice(binary)])
		const args = ['-m', model, '--host', '127.0.0.1', '--port', String(port), '--api-key', this.token,
			'-c', String(options.context ?? 8192), '--jinja', '--no-webui', '-ngl', '99']
		if (device) args.push('--device', device)
		holdGpu(GPU_OWNER, DEFAULT_LIMITS)
		const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
		this.proc = child
		this.url = `http://127.0.0.1:${port}`
		let tail = ''
		child.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2_000) })
		child.on('exit', (code, signal) => {
			if (this.proc !== child) return
			this.proc = null
			this.url = null
			releaseGpu(GPU_OWNER)
			if (this.info.status !== 'off') {
				console.error(`[ai:engine] llama-server exited (code=${code}, signal=${signal})`, tail.split('\n').slice(-5).join(' | '))
				this.set({ status: 'error', error: `the engine stopped (code ${code ?? signal})` })
			}
		})
		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline && this.proc === child) {
			try {
				const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(1_000) })
				if (res.ok) {
					console.log(`[ai:engine] on: ${model} (${device ?? 'CPU'})`)
					this.set({ status: 'on' })
					this.touch()
					return
				}
			}
			catch { /* still loading */ }
			await new Promise(resolve => setTimeout(resolve, 500))
		}
		if (this.proc === child) await this.stop()
		this.set({ status: 'error', error: 'the engine did not start' })
		throw new Error('ai engine did not start')
	}

	/**
	 * A call to the text server (its OpenAI-compatible API: /v1/chat/completions…), with its token;
	 * waits for a hot GPU to cool first. The caller reads the response (a stream when it asked one).
	 */
	async request(path: string, init: RequestInit = {}): Promise<Response> {
		if (this.info.status !== 'on' || !this.url) throw new Error('the engine is not running')
		this.touch()
		await waitForCoolGpu()
		const headers = new Headers(init.headers)
		headers.set('Authorization', `Bearer ${this.token}`)
		return fetch(`${this.url}${path}`, { ...init, headers })
	}

	/** Stops it (the GPU's clocks come back). */
	async stop(sync = false): Promise<void> {
		if (this.idle) clearTimeout(this.idle)
		this.idle = null
		const child = this.proc
		this.proc = null
		this.url = null
		if (this.info.status !== 'off') this.set({ status: 'off', model: null, progress: null, error: null })
		if (!child) return
		child.kill('SIGTERM')
		if (!sync) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => { child.kill('SIGKILL'); resolve() }, STOP_TIMEOUT_MS)
				child.once('exit', () => { clearTimeout(timer); resolve() })
			})
		}
		releaseGpu(GPU_OWNER, sync)
	}
}

export const localEngine = new LocalEngine()
