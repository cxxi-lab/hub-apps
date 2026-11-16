import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export type EngineStatus = 'off' | 'starting' | 'on' | 'error'

export interface EngineInfo {
	status: EngineStatus
	/** true when an Ollama we did not spawn was already listening */
	external: boolean
	error: string | null
}

export const OLLAMA_HOST = '127.0.0.1:11434'
export const OLLAMA_URL = `http://${OLLAMA_HOST}`

const READY_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 5_000

// The local AI engine is never started on its own: it holds GPU memory, so the user
// switches it on/off from the Window menu. Default binary is a user-space install.
function resolveBinary(): string | null {
	const candidates = [
		process.env.COMPANION_OLLAMA_BIN,
		path.join(homedir(), '.local/ollama/bin/ollama'),
		'/usr/local/bin/ollama',
		'/usr/bin/ollama'
	]
	return candidates.find((c): c is string => !!c && existsSync(c)) ?? null
}

async function isUp(): Promise<boolean> {
	try {
		const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(1_000) })
		return res.ok
	}
	catch {
		return false
	}
}

class Engine extends EventEmitter {
	private child: ChildProcess | null = null
	private _info: EngineInfo = { status: 'off', external: false, error: null }

	getInfo(): EngineInfo {
		return this._info
	}

	isOn(): boolean {
		return this._info.status === 'on'
	}

	private setInfo(status: EngineStatus, external = this._info.external, error: string | null = null): void {
		this._info = { status, external, error }
		console.log('[companion:engine] status:', this._info)
		this.emit('status', this._info)
	}

	async start(): Promise<void> {
		if (this._info.status === 'on' || this._info.status === 'starting') return

		if (await isUp()) {
			this.setInfo('on', true)
			return
		}

		const binary = resolveBinary()
		if (!binary) {
			this.setInfo('error', false, 'ollama binary not found (set COMPANION_OLLAMA_BIN)')
			return
		}

		this.setInfo('starting', false)
		const child = spawn(binary, ['serve'], {
			stdio: ['ignore', 'ignore', 'pipe'],
			env: {
				...process.env,
				OLLAMA_HOST,
				OLLAMA_FLASH_ATTENTION: '1',
				OLLAMA_KV_CACHE_TYPE: 'q8_0',
				// Render with the Modelfile's TEMPLATE only: some GGUFs embed a Jinja template that
				// rejects the system notes sent after the last user message.
				OLLAMA_GO_TEMPLATE: '1'
			}
		})
		this.child = child

		child.stderr?.on('data', (d: Buffer) => {
			for (const line of d.toString().split('\n')) {
				if (/level=(ERROR|WARN)/.test(line)) console.warn('[companion:ollama]', line.trimEnd())
			}
		})

		child.on('exit', (code, signal) => {
			this.child = null
			if (this._info.status === 'off') return
			this.setInfo('error', false, `ollama exited (code=${code}, signal=${signal})`)
		})

		child.on('error', err => {
			this.child = null
			this.setInfo('error', false, err.message)
		})

		const deadline = Date.now() + READY_TIMEOUT_MS
		while (Date.now() < deadline) {
			if (!this.child) return
			if (await isUp()) {
				this.setInfo('on', false)
				return
			}
			await new Promise(r => setTimeout(r, 300))
		}
		this.killChild()
		this.setInfo('error', false, 'ollama did not become ready')
	}

	async stop(): Promise<void> {
		if (this._info.status === 'off') return

		if (this.child) {
			const child = this.child
			this.setInfo('off', false)
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					child.kill('SIGKILL')
					resolve()
				}, STOP_TIMEOUT_MS)
				child.once('exit', () => {
					clearTimeout(timer)
					resolve()
				})
				child.kill('SIGTERM')
			})
			return
		}

		// An external Ollama is not ours to kill: free the GPU by unloading its models.
		if (this._info.external) await unloadAllModels()
		this.setInfo('off', false)
	}

	/** Synchronous best-effort kill, for app shutdown. */
	killChild(): void {
		this.child?.kill('SIGTERM')
		this.child = null
	}
}

const UNLOAD_TIMEOUT_MS = 10_000

async function loadedModels(): Promise<string[]> {
	const res = await fetch(`${OLLAMA_URL}/api/ps`)
	const { models } = await res.json() as { models: Array<{ name: string }> }
	return models.map(m => m.name)
}

/** Frees the GPU without stopping the engine; resolves once the memory is actually released. */
export async function unloadAllModels(): Promise<void> {
	try {
		await Promise.all((await loadedModels()).map(name => fetch(`${OLLAMA_URL}/api/generate`, {
			method: 'POST',
			body: JSON.stringify({ model: name, keep_alive: 0 })
		})))
		const deadline = Date.now() + UNLOAD_TIMEOUT_MS
		while ((await loadedModels()).length > 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 200))
	}
	catch (err) {
		console.warn('[companion:engine] unload failed', err)
	}
}

export const engine = new Engine()
