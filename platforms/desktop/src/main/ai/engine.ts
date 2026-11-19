import { app } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
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
 * holds the GPU (its limits: ai/gpu.ts). The image (stable-diffusion.cpp's sd-server) and voice
 * (qwentts.cpp's tts-server) servers share that lifecycle (client docs/plan-ia-compagnon.md, phase 1):
 * one server on the GPU at a time (a text model and an image model don't fit together in 8 GB), a
 * switch waiting for the requests under way (use()).
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

/**
 * The running server, written down: an app that crashed (or was killed) leaves its server behind,
 * holding the GPU's memory; the next start stops it — only if that process is still the engine's
 * own binary (its /proc exe), never anything else that took its pid.
 */
const pidFile = (): string => path.join(app.getPath('userData'), 'ai-engine.pid')

export function reapOrphanServer(): void {
	if (!existsSync(pidFile())) return
	try {
		const { pid, binary } = JSON.parse(readFileSync(pidFile(), 'utf8')) as { pid: number, binary: string }
		if (Number.isInteger(pid) && existsSync(`/proc/${pid}`) && readlinkSync(`/proc/${pid}/exe`) === binary) {
			process.kill(pid, 'SIGTERM')
			console.log(`[ai:engine] stopped the server a previous run left behind (pid ${pid})`)
		}
	}
	catch { /* gone already */ }
	rmSync(pidFile(), { force: true })
}

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
	/** a vision model's projector (its mmproj file) */
	mmproj?: string
	/** a built-in chat template instead of the model's (llama.cpp's names: chatml…) */
	template?: string
}

/** One of the engine's servers, for one model: how to start it and know it is ready. */
interface ServerSpec {
	/** what it runs (the same key: the same server, kept) */
	key: string
	binary: 'llama-server' | 'sd-server' | 'tts-server'
	args: (port: number, device: string | null) => string[]
	/** its readiness: a path answering 200 (and, for sd-server, its model loaded) */
	health: string
	ready?: (res: Response) => Promise<boolean>
	/** it takes the engine's token (llama-server's --api-key); the others listen on 127.0.0.1 only */
	auth: boolean
}

class LocalEngine extends EventEmitter {
	private info: EngineInfo = { status: 'off', model: null, progress: null, error: null }
	private proc: ChildProcess | null = null
	private url: string | null = null
	readonly token = randomBytes(24).toString('hex')
	private idle: NodeJS.Timeout | null = null
	private starting: Promise<void> | null = null
	private spec: ServerSpec | null = null
	// the requests under way on the running server, and those waiting for it to switch
	private inFlight = 0
	private settledWaiters: Array<() => void> = []

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

	private settled(): Promise<void> {
		return new Promise(resolve => this.inFlight === 0 ? resolve() : this.settledWaiters.push(resolve))
	}

	/**
	 * Runs `fn` on the server `spec` describes: started (or switched to, once the requests under way on
	 * another one are done), kept while `fn` runs.
	 */
	async use<T>(spec: ServerSpec, fn: () => Promise<T>): Promise<T> {
		while (this.info.model !== spec.key && this.inFlight > 0) await this.settled()
		this.inFlight++
		try {
			await this.serve(spec)
			return await fn()
		}
		finally {
			this.inFlight--
			if (this.inFlight === 0) { const waiting = this.settledWaiters; this.settledWaiters = []; waiting.forEach(w => w()) }
		}
	}

	/** The text server running `model` (a GGUF file): started, or restarted on another model. */
	text(model: string, options: TextOptions = {}): Promise<void> {
		return this.serve(textSpec(model, options, this.token))
	}

	private async serve(spec: ServerSpec): Promise<void> {
		if (this.info.status === 'on' && this.info.model === spec.key) {
			this.touch()
			return
		}
		if (this.starting && this.info.model === spec.key) return this.starting
		await this.stop()
		this.starting = this.start(spec).finally(() => { this.starting = null })
		return this.starting
	}

	private async start(spec: ServerSpec): Promise<void> {
		const model = spec.key
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
		const binary = engineBinary(spec.binary)
		if (!binary) {
			this.set({ status: 'error', error: `this engine has no ${spec.binary}` })
			throw new Error(`ai engine: no ${spec.binary}`)
		}
		this.set({ status: 'starting', model, progress: null, error: null })
		// the GPUs as ggml names them (the same for the three servers)
		const [port, device] = await Promise.all([freePort(), bestDevice(engineBinary('llama-server') ?? binary)])
		const args = spec.args(port, device)
		holdGpu(GPU_OWNER, DEFAULT_LIMITS)
		const child = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'] })
		this.proc = child
		this.url = `http://127.0.0.1:${port}`
		if (child.pid) writeFileSync(pidFile(), JSON.stringify({ pid: child.pid, binary }))
		let tail = ''
		child.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2_000) })
		this.spec = spec
		child.on('exit', (code, signal) => {
			rmSync(pidFile(), { force: true })
			if (this.proc !== child) return
			this.proc = null
			this.url = null
			this.spec = null
			releaseGpu(GPU_OWNER)
			if (this.info.status !== 'off') {
				console.error(`[ai:engine] ${spec.binary} exited (code=${code}, signal=${signal})`, tail.split('\n').slice(-5).join(' | '))
				this.set({ status: 'error', error: `the engine stopped (code ${code ?? signal})` })
			}
		})
		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline && this.proc === child) {
			try {
				const res = await fetch(`${this.url}${spec.health}`, { signal: AbortSignal.timeout(1_000), headers: spec.auth ? { Authorization: `Bearer ${this.token}` } : {} })
				if (res.ok && (!spec.ready || await spec.ready(res))) {
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
		if (this.spec?.auth) headers.set('Authorization', `Bearer ${this.token}`)
		return fetch(`${this.url}${path}`, { ...init, headers })
	}

	/** Stops it (the GPU's clocks come back). */
	async stop(sync = false): Promise<void> {
		if (this.idle) clearTimeout(this.idle)
		this.idle = null
		const child = this.proc
		this.proc = null
		this.url = null
		this.spec = null
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

// --- the three servers ---

function textSpec(model: string, options: TextOptions, token: string): ServerSpec {
	return {
		key: [model, options.mmproj, options.template].filter(Boolean).join('|'),
		binary: 'llama-server',
		args: (port, device) => [
			'-m', model, '--host', '127.0.0.1', '--port', String(port), '--api-key', token,
			'-c', String(options.context ?? 8192), '--jinja', '--no-webui', '-ngl', '99',
			...(options.mmproj ? ['--mmproj', options.mmproj] : []),
			...(options.template ? ['--chat-template', options.template] : []),
			...(device ? ['--device', device] : [])
		],
		health: '/health',
		auth: true
	}
}

/** stable-diffusion.cpp's server on one checkpoint, its LoRA in `loraDir` (by file name). */
export function imageSpec(checkpoint: string, loraDir: string): ServerSpec {
	return {
		key: `image:${checkpoint}`,
		binary: 'sd-server',
		args: (port, device) => ['-m', checkpoint, '--lora-model-dir', loraDir, '-l', '127.0.0.1', '--listen-port', String(port), ...(device ? ['--backend', device] : [])],
		health: '/sdcpp/v1/models/status',
		ready: async res => ((await res.json().catch(() => null)) as { state?: string } | null)?.state === 'ready',
		auth: false
	}
}

/** qwentts.cpp's server on one voice model (its talker and its codec). */
export function voiceSpec(talker: string, codec: string): ServerSpec {
	return {
		key: `voice:${talker}`,
		binary: 'tts-server',
		args: (port, device) => ['--model', talker, '--codec', codec, '--host', '127.0.0.1', '--port', String(port), ...(device ? ['--device', device] : [])],
		health: '/health',
		auth: false
	}
}

/** The text server's spec (for use()). */
export const textServer = (model: string, options: TextOptions = {}): ServerSpec => textSpec(model, options, localEngine.token)

export const localEngine = new LocalEngine()
