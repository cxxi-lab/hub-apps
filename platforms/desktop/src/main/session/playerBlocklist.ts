import { app, ipcMain } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { webSessions } from './sessions'

// Hosts blocked in the webview sessions (ads, trackers): without it a site's
// player waits on its ad sequence and never starts the video. The list is
// compiled by the back from public domain blocklists (Video hubby,
// PlayerBlocklist) and pushed by the renderer (platform.setPlayerBlocklist);
// the mobile shell applies the same list. A request to a listed domain or any
// of its subdomains is cancelled.
//
// Previously: Ghostery's prebuilt ads & tracking engine (@ghostery/adblocker-electron
// ^2.18.1) — ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, { path, read, write })
// cached in userData/adblocker-engine.bin, network filters only
// (loadCosmeticFilters: false: its scriptlets broke the video site's own scripts),
// enabled with enableBlockingInSession() on every webSessions() entry.
// Replaced so desktop and mobile share one back-driven list.

const LIST_PATH = join(app.getPath('userData'), 'player-blocklist.txt')

let version: string | null = null
let hosts = new Set<string>()

function isBlocked(host: string): boolean {
	// The host itself, then each parent domain: a.b.example.com → b.example.com → example.com.
	for (let h = host; ; h = h.slice(h.indexOf('.') + 1)) {
		if (hosts.has(h)) return true
		if (!h.includes('.')) return false
	}
}

function load(): void {
	if (!existsSync(LIST_PATH)) return
	try {
		const [header, ...lines] = readFileSync(LIST_PATH, 'utf8').split('\n')
		if (!header.startsWith('# version ')) return
		version = header.slice(10)
		hosts = new Set(lines.filter(Boolean))
	}
	catch (err) {
		console.warn('[blocklist] failed to load:', err)
	}
}

export function setupPlayerBlocklist(): void {
	load()
	for (const sess of webSessions()) {
		sess.webRequest.onBeforeRequest((details, callback) => {
			let host: string
			try { host = new URL(details.url).hostname }
			catch { return callback({}) }
			callback({ cancel: hosts.size > 0 && isBlocked(host) })
		})
	}
	console.log(`[blocklist] ${hosts.size} hosts (version ${version ?? 'none'})`)
}

ipcMain.handle('player-blocklist:version', () => version)

ipcMain.handle('player-blocklist:set', (_, payload: { version: string; hosts: string[] }) => {
	version = payload.version
	hosts = new Set(payload.hosts)
	try {
		writeFileSync(LIST_PATH, `# version ${payload.version}\n${payload.hosts.join('\n')}\n`, { mode: 0o600 })
	}
	catch (err) {
		console.warn('[blocklist] failed to persist:', err)
	}
	console.log(`[blocklist] updated: ${hosts.size} hosts (version ${version})`)
})
