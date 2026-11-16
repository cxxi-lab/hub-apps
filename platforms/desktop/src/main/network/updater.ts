import { app, BrowserWindow, ipcMain, net, Notification } from 'electron'
import pkg from 'electron-updater'
import { createHash, verify } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { UPDATE_SIGNING_PUBLIC_KEY } from './updateSigningKey'
import { answerProxyLogin } from './vpn'
import { showMainWindow } from '../windows/main'
import { openUpdateWindow } from '../windows/update'

const { autoUpdater } = pkg

export const RELEASES_URL = 'https://hub.cxxi.io/releases/'

/** Longest the app window waits on the startup check before opening anyway. */
const CHECK_DEADLINE_MS = 15_000
const CHECK_TIMEOUT_MS = 8_000
const RETRY_DELAY_MS = 3_000
/** hub keeps running in the tray: look for a new release regularly, not only at launch. */
const PERIODIC_CHECK_MS = 15 * 60_000

export type UpdatePhase = 'available' | 'downloading' | 'verifying' | 'installing' | 'error'

export interface UpdateProgress {
	percent: number
	transferred: number
	total: number
	bytesPerSecond: number
}

export interface UpdateState {
	phase: UpdatePhase
	version: string
	currentVersion: string
	progress: UpdateProgress | null
	error: string | null
}

let state: UpdateState | null = null
let checking = false
const foundListeners = new Set<() => void>()

function setState(patch: Partial<UpdateState>): void {
	if (!state) return
	state = { ...state, ...patch }
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send('update:state:changed', state)
	}
}

/**
 * GET through the updater's session. Uses net.request rather than session.fetch
 * so the local proxy's auth challenge is answered explicitly.
 */
export function fetchBuffer(url: string): Promise<{ status: number, body: Buffer }> {
	return new Promise((resolve, reject) => {
		const request = net.request({ url, session: autoUpdater.netSession, useSessionCookies: false, cache: 'no-store' })
		request.on('login', (authInfo, callback) => {
			if (!answerProxyLogin(authInfo, callback)) callback()
		})
		request.on('response', response => {
			const chunks: Buffer[] = []
			response.on('data', chunk => chunks.push(Buffer.from(chunk)))
			response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) }))
			response.on('error', reject)
		})
		request.on('error', reject)
		request.end()
	})
}

async function sha512Base64(file: string): Promise<string> {
	const hash = createHash('sha512')
	for await (const chunk of createReadStream(file)) {
		hash.update(chunk as Buffer)
	}
	return hash.digest('base64')
}

/**
 * electron-updater only checks the AppImage against the sha512 listed in
 * latest-linux.yml, which comes from the same server as the binary. The release
 * pipeline also signs that manifest (Ed25519): an update is installed only if the
 * signature matches the key embedded in this build AND the downloaded file's hash
 * is listed in the signed manifest for the downloaded version.
 */
async function verifyDownloadedUpdate(version: string, file: string): Promise<void> {
	const [manifestRes, signatureRes] = await Promise.all([
		fetchBuffer(`${RELEASES_URL}latest-linux.yml`),
		fetchBuffer(`${RELEASES_URL}latest-linux.yml.sig`)
	])
	if (manifestRes.status !== 200 || signatureRes.status !== 200) {
		throw new Error(`manifest or signature unavailable (HTTP ${manifestRes.status}/${signatureRes.status})`)
	}

	const manifest = manifestRes.body
	const signature = signatureRes.body
	if (!verify(null, manifest, UPDATE_SIGNING_PUBLIC_KEY, signature)) {
		throw new Error('manifest signature is invalid')
	}

	const text = manifest.toString('utf8')
	const signedVersion = text.match(/^version:\s*['"]?([^'"\s]+)/m)?.[1]
	if (signedVersion !== version) {
		throw new Error(`signed manifest is for ${signedVersion ?? 'unknown'}, downloaded ${version}`)
	}

	const signedHashes = [...text.matchAll(/^\s*(?:-\s+)?sha512:\s*(\S+)\s*$/gm)].map(m => m[1])
	const actual = await sha512Base64(file)
	if (!signedHashes.includes(actual)) {
		throw new Error('downloaded file does not match the signed manifest')
	}
}

function configure(): void {
	autoUpdater.autoDownload = false
	// Never install on quit: that path would skip the signature check below.
	autoUpdater.autoInstallOnAppQuit = false

	// electron-updater's own requests (check, download) relay proxy challenges here.
	autoUpdater.on('login', (authInfo, callback) => {
		if (!answerProxyLogin(authInfo, callback)) callback('', '')
	})

	autoUpdater.on('download-progress', progress => {
		if (state?.phase !== 'downloading') return
		setState({
			progress: {
				percent: progress.percent,
				transferred: progress.transferred,
				total: progress.total,
				bytesPerSecond: progress.bytesPerSecond
			}
		})
	})

	autoUpdater.on('error', err => {
		console.warn('[updater] error', err.message)
	})
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`check timed out after ${ms / 1000}s`)), ms)
		promise.then(
			value => { clearTimeout(timer); resolve(value) },
			err => { clearTimeout(timer); reject(err) }
		)
	})
}

/**
 * Checks the release endpoint once per launch. Resolves true when an update is
 * available (state is then 'available'). Failures resolve false: an unreachable
 * endpoint must not keep the app from opening.
 */
async function check(): Promise<boolean> {
	if (checking || state) return false
	checking = true
	try {
		return await checkOnce()
	}
	finally {
		checking = false
	}
}

async function checkOnce(): Promise<boolean> {
	const deadline = Date.now() + CHECK_DEADLINE_MS
	for (let attempt = 1; ; attempt++) {
		try {
			const result = await withTimeout(autoUpdater.checkForUpdates(), Math.min(CHECK_TIMEOUT_MS, Math.max(1_000, deadline - Date.now())))
			if (!result?.isUpdateAvailable) {
				console.log('[updater] already on latest')
				return false
			}
			state = {
				phase: 'available',
				version: result.updateInfo.version,
				currentVersion: app.getVersion(),
				progress: null,
				error: null
			}
			return true
		}
		catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			// The network can be settling at launch (Wi-Fi coming up): an early check may fail
			// transiently.
			const transient = /SOCKS|TIMED_OUT|timed out|ECONN|ENOTFOUND|ERR_|network/i.test(msg)
			if (!transient || Date.now() + RETRY_DELAY_MS >= deadline) {
				console.warn(`[updater] check gave up after ${attempt} attempt(s):`, msg)
				return false
			}
			console.warn(`[updater] check failed (${msg}), retrying in ${RETRY_DELAY_MS / 1000}s`)
			await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
		}
	}
}

/**
 * Downloads, verifies and installs the pending update, reporting each step to
 * the update window. Any failure lands in the 'error' phase, from which the user
 * can retry.
 */
async function install(): Promise<void> {
	if (!state || (state.phase !== 'available' && state.phase !== 'error')) return

	setState({ phase: 'downloading', progress: null, error: null })
	try {
		const files = await autoUpdater.downloadUpdate()
		const file = files.find(f => f.endsWith('.AppImage')) ?? files[0]
		if (!file) throw new Error('download produced no file')

		setState({ phase: 'verifying' })
		try {
			await verifyDownloadedUpdate(state.version, file)
		}
		catch (err) {
			throw new Error(`release signature could not be verified: ${err instanceof Error ? err.message : String(err)}`)
		}

		setState({ phase: 'installing' })
		// Leave the window a moment to show the restart before it closes.
		setTimeout(() => autoUpdater.quitAndInstall(false, true), 1_000)
	}
	catch (err) {
		const reason = err instanceof Error ? err.message : String(err)
		console.error('[updater] update failed:', reason)
		setState({ phase: 'error', error: reason })
	}
}

/**
 * Shows the update window in place of the app. Windows already open (a check that
 * succeeded after launch) are closed once it is visible: the app isn't used while an
 * update is pending.
 */
function takeOver(): void {
	const others = BrowserWindow.getAllWindows()
	const win = openUpdateWindow()
	win.once('show', () => {
		for (const other of others) {
			if (other !== win && !other.isDestroyed()) other.close()
		}
	})
}

/**
 * Checks for an update before the app window opens. Resolves true when one was
 * found: only the update window is shown then, and the app window must not open.
 * Resolves false when the app should open (up to date, or the check was impossible).
 */
export async function checkForUpdateAtStartup(): Promise<boolean> {
	configure()
	startPeriodicChecks()

	const found = await check()
	if (found) takeOver()
	return found
}

/**
 * While hub runs (often hidden in the tray), checks again every half hour. A release found
 * this way does not interrupt: it is announced, and installed from the tray menu.
 */
function startPeriodicChecks(): void {
	setInterval(() => {
		if (state) return
		void check().then(found => {
			if (!found || !state) return
			console.log('[updater] update found while running:', state.version)
			notify(`Version ${state.version} is available — update from the tray menu.`, openPendingUpdate)
			foundListeners.forEach(listener => listener())
		})
	}, PERIODIC_CHECK_MS)
}

function notify(body: string, onClick?: () => void): void {
	if (!Notification.isSupported()) return
	const notification = new Notification({ title: 'Hubbyware', body })
	if (onClick) notification.on('click', onClick)
	notification.show()
}

/**
 * Check asked from the tray menu: opens the update window when a release is available,
 * says so when hub is up to date.
 */
export async function checkForUpdateNow(): Promise<void> {
	if (state) return openPendingUpdate()
	if (!app.isPackaged) return notify('Updates are only checked in the packaged app.')
	const found = await check()
	if (found) {
		foundListeners.forEach(listener => listener())
		openPendingUpdate()
	}
	else if (!state) notify(`hub ${app.getVersion()} is up to date.`)
}

/** Version of the update found and not installed yet, if any. */
export function pendingUpdateVersion(): string | null {
	return state && state.phase !== 'installing' ? state.version : null
}

/** Opens the update window for the pending update (download, verification, install). */
export function openPendingUpdate(): void {
	if (state) takeOver()
}

export function onUpdateFound(listener: () => void): void {
	foundListeners.add(listener)
}

ipcMain.handle('update:state:get', () => state)

ipcMain.handle('update:install', () => { void install() })

ipcMain.handle('update:quit', () => app.quit())

// Escape hatch from a failed update only (e.g. a broken release): open the app anyway.
ipcMain.handle('update:skip', event => {
	if (state?.phase !== 'error') return
	showMainWindow()
	BrowserWindow.fromWebContents(event.sender)?.close()
})
