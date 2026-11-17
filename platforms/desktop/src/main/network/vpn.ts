import { app, BrowserWindow, dialog, ipcMain, session, type AuthInfo } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
const isDev = !app.isPackaged
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, promises as fsp, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { resolveWireproxyBinary } from './wireproxy'
import { configInfo, defaultVpnHubby, readConfig, removeConfig, validHubby, writeConfig } from './vpnConfig'
import { BROWSE_PARTITION } from '../session/sessions'

export type VpnStatus = 'disabled' | 'starting' | 'connected' | 'error'

export interface VpnInfo {
	status: VpnStatus
	port: number | null
	error: string | null
	endpoint: string | null
	/** the hubby the tunnel runs for (its config, ./vpnConfig.ts) */
	hubby: string | null
}

// First port tried; the next ones are used when it is taken (another hub instance,
// e.g. the installed AppImage next to `npm run dev`, or a leftover wireproxy).
const PROXY_PORT = 25344
const PROXY_PORT_ATTEMPTS = 10

// wireproxy exposes an authenticated HTTP proxy rather than SOCKS5, which
// Chromium can't authenticate to. Fresh random credentials per launch keep other
// local processes and users from riding the tunnel to the VPN-only API; they only
// live in memory and in the short-lived proxy config (deleted once wireproxy is up).
const PROXY_USERNAME = 'hub'
const PROXY_PASSWORD = randomBytes(24).toString('hex')
const READY_TIMEOUT_MS = 10_000

class VpnManager extends EventEmitter {
	private child: ChildProcess | null = null
	private _info: VpnInfo = { status: 'disabled', port: null, error: null, endpoint: null, hubby: null }
	private proxyConfigDir: string | null = null
	private proxyPort: number | null = null

	getProxyPort(): number | null {
		return this.proxyPort
	}

	getInfo(): VpnInfo {
		return this._info
	}

	private setStatus(status: VpnStatus, port: number | null = null, error: string | null = null, endpoint: string | null = this._info.endpoint): void {
		this._info = { status, port, error, endpoint, hubby: this._info.hubby }
		console.log('[vpn] status:', this._info)
		this.emit('status', this._info)
	}

	private parseEndpoint(wgConfigContent: string): string | null {
		const match = wgConfigContent.match(/^\s*Endpoint\s*=\s*(.+)$/im)
		return match ? match[1].trim() : null
	}

	private starting: Promise<void> | null = null

	/**
	 * Starts the tunnel for a hubby, with its config (none named: the first hubby going out through
	 * the VPN). Once: a start already under way is the one awaited; one tunnel at a time, so one
	 * running for another hubby is stopped first.
	 */
	async start(hubby?: string): Promise<void> {
		const wanted = hubby ?? defaultVpnHubby()
		if (this.starting) await this.starting
		if (this.child && this._info.hubby === wanted) return
		if (this.child) await this.stop()
		this.starting ??= this.launch(wanted).finally(() => { this.starting = null })
		return this.starting
	}

	private async launch(hubby: string | null): Promise<void> {
		this._info = { ...this._info, hubby }
		this.setStatus('starting')
		const binary = await resolveWireproxyBinary()
		if (!binary) {
			this.setStatus('error', null, `the VPN tunnel couldn't be installed on this device (${process.platform}-${process.arch})`)
			return
		}

		const config = hubby ? readConfig(hubby) : null
		if (!config) {
			this.setStatus('disabled', null, 'no WireGuard config: add yours in the hubby\'s settings (VPN)')
			return
		}

		const port = await findFreePort(PROXY_PORT, PROXY_PORT_ATTEMPTS)
		if (port === null) {
			this.setStatus('error', null, `no free proxy port in ${PROXY_PORT}-${PROXY_PORT + PROXY_PORT_ATTEMPTS - 1}`)
			return
		}

		let proxyConfigPath: string
		try {
			proxyConfigPath = this.buildProxyConfig(config, port)
		}
		catch (err) {
			this.setStatus('error', null, err instanceof Error ? err.message : 'failed to build wireproxy config')
			return
		}

		this.proxyPort = port
		this.setStatus('starting', port)

		const child = spawn(binary, ['-c', proxyConfigPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		this.child = child

		const forwardLog = (channel: 'log' | 'warn', tag: string) => (d: Buffer) => {
			const text = d.toString()
			for (const line of text.split('\n')) {
				const trimmed = line.trimEnd()
				if (trimmed === '') continue
				// Wireproxy logs every routine at DEBUG level which floods stderr.
				// Keep DEBUG lines in dev, drop them in packaged builds.
				if (!isDev && trimmed.includes('DEBUG:')) continue
				console[channel](tag, trimmed)
			}
		}

		child.stdout?.on('data', forwardLog('log', '[vpn:stdout]'))
		child.stderr?.on('data', forwardLog('warn', '[vpn:stderr]'))

		child.on('exit', (code, signal) => {
			console.warn('[vpn] wireproxy exited', { code, signal })
			this.child = null
			if (this._info.status === 'connected' || this._info.status === 'starting') {
				this.setStatus('error', null, `wireproxy exited (code=${code}, signal=${signal})`)
			}
		})

		child.on('error', err => {
			console.error('[vpn] spawn error', err)
			this.child = null
			this.cleanupProxyConfig()
			this.setStatus('error', null, err.message)
		})

		try {
			await this.waitForPort(port, READY_TIMEOUT_MS, child)
			// wireproxy parses its config once at startup: the private key can go.
			this.cleanupProxyConfig()
			this.setStatus('connected', port)
		}
		catch (err) {
			this.cleanupProxyConfig()
			this.setStatus('error', null, err instanceof Error ? err.message : 'wireproxy did not become ready')
			child.kill('SIGTERM')
			this.child = null
		}
	}

	async stop(): Promise<void> {
		this.cleanupProxyConfig()
		const child = this.child
		if (!child) {
			if (this._info.status !== 'disabled') this.setStatus('disabled')
			return
		}
		this.child = null
		this.setStatus('disabled')
		child.kill('SIGTERM')
		setTimeout(() => {
			if (!child.killed) {
				try { child.kill('SIGKILL') } catch {}
			}
		}, 2_000)
	}

	private buildProxyConfig(original: string, port: number): string {
		this._info = { ...this._info, endpoint: this.parseEndpoint(original) }
		const withoutProxies = original
			.replace(/(^|\n)\[(Socks5|http)\][\s\S]*?(?=\n\[|$)/gi, '')
			.trim()
		const merged = `${withoutProxies}\n\n[http]\nBindAddress = 127.0.0.1:${port}\nUsername = ${PROXY_USERNAME}\nPassword = ${PROXY_PASSWORD}\n`

		// The merged config holds the WireGuard private key: write it in a fresh
		// private directory (mkdtemp creates it 0700) with an exclusive create, and
		// delete it as soon as wireproxy has read it.
		this.cleanupProxyConfig()
		const dir = mkdtempSync(path.join(tmpdir(), 'hub-wireproxy-'))
		this.proxyConfigDir = dir
		const outPath = path.join(dir, 'wireproxy.conf')
		writeFileSync(outPath, merged, { mode: 0o600, flag: 'wx' })
		return outPath
	}

	private cleanupProxyConfig(): void {
		if (!this.proxyConfigDir) return
		try {
			rmSync(this.proxyConfigDir, { recursive: true, force: true })
		}
		catch (err) {
			console.warn('[vpn] could not remove proxy config', err)
		}
		this.proxyConfigDir = null
	}

	// Fails as soon as the child dies, so a port answered by someone else is never
	// mistaken for our tunnel being up.
	private waitForPort(port: number, timeoutMs: number, child: ChildProcess): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = Date.now()
			const tryConnect = () => {
				if (child.exitCode !== null || child.signalCode !== null) {
					reject(new Error(`wireproxy exited before listening on ${port}`))
					return
				}
				const sock = net.connect(port, '127.0.0.1')
				let settled = false
				sock.once('connect', () => {
					settled = true
					sock.destroy()
					resolve()
				})
				sock.once('error', () => {
					if (settled) return
					sock.destroy()
					if (Date.now() - start > timeoutMs) {
						reject(new Error(`Proxy port ${port} unreachable after ${timeoutMs}ms`))
					}
					else {
						setTimeout(tryConnect, 200)
					}
				})
			}
			tryConnect()
		})
	}
}

/** First port from `start` that nothing listens on locally, or null. */
async function findFreePort(start: number, attempts: number): Promise<number | null> {
	for (let port = start; port < start + attempts; port++) {
		const free = await new Promise<boolean>(resolve => {
			const probe = net.createServer()
			probe.once('error', () => resolve(false))
			probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
		})
		if (free) return port
	}
	return null
}

export const vpnManager = new VpnManager()

// wireproxy is not tied to our lifetime: when the app dies without a clean quit
// (electron-vite restarting main in dev, a crash) it would keep holding the port.
process.on('exit', () => {
	void vpnManager.stop()
})

// Kill switch: while the tunnel is not up, what must go through it points at a proxy port
// nothing listens on (port 1: unbindable by unprivileged processes), so it fails to load instead
// of silently going out from the real IP. Local addresses stay reachable.
const BLACKHOLE_PROXY = '127.0.0.1:1'
const LOCAL_BYPASS = '<local>;localhost;127.0.0.1;::1'

/**
 * Only the embedded browser and players (the sites a hubby going out through the VPN opens) go
 * through the tunnel. Everything else is direct: the app's own session (the API, on its public
 * name), the updater (server docs/plan-reseau-vpn.md).
 */
async function applyVpnProxy(info: VpnInfo): Promise<void> {
	const connected = info.status === 'connected' && info.port !== null
	const proxy = connected ? `127.0.0.1:${info.port}` : BLACKHOLE_PROXY

	await Promise.all([
		// a PAC script from before (the former VPN-only name of the server): direct again
		session.defaultSession.setProxy({ mode: 'direct' }),
		session.fromPartition(BROWSE_PARTITION).setProxy({ proxyRules: `http://${proxy}`, proxyBypassRules: LOCAL_BYPASS })
	])

	if (connected) console.log('[vpn] proxy applied:', info.port, '(the browser)')
	else console.log('[vpn] tunnel down: the browser blocked')
}

// Before the private temp dir, the config was left behind as <tmp>/wireproxy-<pid>.conf.
function removeLegacyProxyConfigs(): void {
	let names: string[] = []
	try {
		names = readdirSync(tmpdir())
	}
	catch {
		return
	}
	for (const name of names) {
		if (!/^wireproxy-\d+\.conf$/.test(name)) continue
		try {
			rmSync(path.join(tmpdir(), name), { force: true })
		}
		catch {
			// Not ours (other user) or already gone.
		}
	}
}

/**
 * Answers a proxy auth challenge only when it comes from our own local wireproxy
 * proxy. Returns false (and supplies nothing) for any other challenge.
 */
export function answerProxyLogin(authInfo: AuthInfo, callback: (username: string, password: string) => void): boolean {
	if (!authInfo.isProxy || authInfo.host !== '127.0.0.1' || authInfo.port !== vpnManager.getProxyPort()) return false
	callback(PROXY_USERNAME, PROXY_PASSWORD)
	return true
}

export function setupVpn(): void {
	removeLegacyProxyConfigs()

	// Requests from windows and webviews: credentials for our proxy, nothing for
	// any other proxy (the challenge is cancelled). Site auth is left to Electron.
	app.on('login', (event, _webContents, _details, authInfo, callback) => {
		if (!authInfo.isProxy) return
		event.preventDefault()
		if (!answerProxyLogin(authInfo, callback)) callback()
	})

	// Until the tunnel runs (it starts when Private opens), what it carries is blocked.
	void applyVpnProxy(vpnManager.getInfo())

	vpnManager.on('status', async (info: VpnInfo) => {
		await applyVpnProxy(info)
		for (const w of BrowserWindow.getAllWindows()) {
			w.webContents.send('vpn:status:changed', info)
		}
	})

	ipcMain.handle('vpn:status:get', () => vpnManager.getInfo())
	ipcMain.handle('vpn:start', (_event, hubby: unknown) => vpnManager.start(validHubby(hubby) ? hubby : undefined))
	ipcMain.handle('vpn:stop', () => vpnManager.stop())
	ipcMain.handle('vpn:config:get', (_event, hubby: unknown) => validHubby(hubby) ? configInfo(hubby) : { configured: false, endpoint: null })
	ipcMain.handle('vpn:config:set', (_event, hubby: unknown, text: unknown) => {
		if (!validHubby(hubby) || typeof text !== 'string') return { ok: false, error: 'invalid config' }
		return saveConfig(hubby, text)
	})
	ipcMain.handle('vpn:config:remove', async (_event, hubby: unknown) => {
		if (!validHubby(hubby)) return
		removeConfig(hubby)
		if (vpnManager.getInfo().hubby === hubby) await vpnManager.stop()
	})
}

/** Saves a hubby's config; its tunnel, running, restarts with it. */
async function saveConfig(hubby: string, text: string): Promise<{ ok: boolean, error?: string }> {
	try {
		writeConfig(hubby, text)
	}
	catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
	const info = vpnManager.getInfo()
	if (info.hubby === hubby && info.status !== 'disabled') {
		await vpnManager.stop()
		await vpnManager.start(hubby)
	}
	return { ok: true }
}

/** Picks a config file for a hubby (none named: the first going out through the VPN), and saves it. */
ipcMain.handle('vpn:config:replace', async (event, named: unknown) => {
	const hubby = validHubby(named) ? named : defaultVpnHubby()
	if (!hubby) return { ok: false, path: null, error: 'no hubby goes out through the VPN' }
	const win = BrowserWindow.fromWebContents(event.sender)
	const result = await dialog.showOpenDialog(win ?? undefined as never, {
		title: 'Select WireGuard config',
		properties: ['openFile'],
		filters: [
			{ name: 'WireGuard config', extensions: ['conf', 'wg'] },
			{ name: 'All files', extensions: ['*'] }
		]
	})

	if (result.canceled || !result.filePaths[0]) {
		return { ok: false, path: null }
	}

	try {
		const saved = await saveConfig(hubby, await fsp.readFile(result.filePaths[0], 'utf8'))
		return { ...saved, path: null }
	}
	catch (err) {
		console.error('[vpn] config replace failed', err)
		return { ok: false, path: null, error: err instanceof Error ? err.message : String(err) }
	}
})

app.on('before-quit', async () => {
	await vpnManager.stop()
})
