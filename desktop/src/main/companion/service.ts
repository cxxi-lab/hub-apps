import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'


const READY_TIMEOUT_MS = 30_000

/** Paths in profile.json may start with `~/`. */
export const expandHome = (p: string): string => p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p

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

/**
 * A bundled Python HTTP service (resources/<dir>/server.py) run with a user-provided
 * interpreter, listening on a free local port. Started lazily, stopped with the engine.
 */
export class LocalService {
	private child: ChildProcess | null = null
	private port: number | null = null
	private ready: Promise<boolean> | null = null

	constructor(private readonly name: string, private readonly dir: string) {}

	private script(): string {
		const base = app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources')
		return path.join(base, this.dir, 'server.py')
	}

	isRunning(): boolean {
		return this.child !== null
	}

	start(python: string, config: unknown): void {
		if (this.child) return
		this.ready = this.spawn(python, config)
	}

	private async spawn(python: string, config: unknown): Promise<boolean> {
		this.port = await freePort()
		const child = spawn(python, ['-I', this.script(), '--port', String(this.port), '--config', JSON.stringify(config)], {
			stdio: ['ignore', 'pipe', 'pipe']
		})
		this.child = child
		const log = (d: Buffer) => {
			for (const line of d.toString().split('\n')) {
				if (/Error|Traceback|rejected|\[photo\]/.test(line)) console.warn(`[companion:${this.name}]`, line.trimEnd())
			}
		}
		child.stdout?.on('data', log)
		child.stderr?.on('data', log)
		child.on('exit', code => {
			if (this.child === child) {
				console.warn(`[companion:${this.name}] service exited`, code)
				this.child = null
				this.ready = null
			}
		})

		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline && this.child === child) {
			try {
				const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(1_000) })
				if (res.ok) return true
			}
			catch { /* not listening yet */ }
			await new Promise(r => setTimeout(r, 300))
		}
		return false
	}

	stop(): void {
		this.child?.kill('SIGTERM')
		this.child = null
		this.ready = null
	}

	/** POSTs a JSON request; throws with the service's error message on failure. */
	async request<T>(route: string, body: unknown, timeoutMs: number): Promise<T> {
		if (!this.ready || !(await this.ready)) throw new Error(`${this.name} service unavailable`)
		const { status, text } = await this.post(route, JSON.stringify(body), timeoutMs)
		const data = JSON.parse(text) as T & { error?: string }
		if (status < 200 || status >= 300) throw new Error(`${this.name} failed: ${data.error ?? status}`)
		return data
	}

	/**
	 * node:http rather than fetch: fetch gives up after 5 min without response headers, and a photo
	 * with its retries and GPU cool-downs can take longer. `timeoutMs` is how long it may stay silent.
	 */
	private post(route: string, payload: string, timeoutMs: number): Promise<{ status: number; text: string }> {
		return new Promise((resolve, reject) => {
			const req = http.request({
				host: '127.0.0.1',
				port: this.port!,
				path: route,
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
				timeout: timeoutMs
			}, res => {
				let text = ''
				res.setEncoding('utf8')
				res.on('data', chunk => { text += chunk })
				res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
				res.on('error', reject)
			})
			req.on('timeout', () => req.destroy(new Error(`${this.name} timed out after ${Math.round(timeoutMs / 1_000)} s`)))
			req.on('error', reject)
			req.end(payload)
		})
	}
}
