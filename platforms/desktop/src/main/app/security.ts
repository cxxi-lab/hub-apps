import { app, session, shell, type Session, type WebContents } from 'electron'
import { BROWSE_PARTITION, webSession, webviewPartition } from '../session/sessions'

// Only what the app and the embedded players actually use. Everything else
// (camera, microphone, geolocation, notifications, MIDI, USB/HID/serial,
// external protocol handlers…) is denied without prompting.
const ALLOWED_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write'])

const hardenedSessions = new WeakSet<Session>()

function hardenSession(sess: Session): void {
	if (hardenedSessions.has(sess)) return
	hardenedSessions.add(sess)

	sess.setPermissionRequestHandler((_contents, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)))
	sess.setPermissionCheckHandler((_contents, permission) => ALLOWED_PERMISSIONS.has(permission))
	sess.setDevicePermissionHandler(() => false)
}

function isSafeExternalUrl(url: string): boolean {
	try {
		return new URL(url).protocol === 'https:'
	}
	catch {
		return false
	}
}

function isAppUrl(url: string): boolean {
	const devUrl = process.env['ELECTRON_RENDERER_URL']
	if (!app.isPackaged && devUrl && url.startsWith(devUrl)) return true
	return url.startsWith('file://')
}

/**
 * Process-wide guards, installed before any window or session exists:
 * - permissions denied by default on every session;
 * - no new windows from any web contents (app windows may hand https links to
 *   the system browser, pages inside webviews get nothing);
 * - app windows can only show the app itself;
 * - webviews can't smuggle a preload or Node, and always run in a webview partition (their
 *   hubby's, persist:hubby:<id>, or the former shared persist:browse), never in the app's own
 *   session (which holds the API cookie).
 */
export function installSecurityHandlers(): void {
	app.on('session-created', hardenSession)

	app.on('web-contents-created', (_event, contents: WebContents) => {
		const isWebview = contents.getType() === 'webview'

		contents.setWindowOpenHandler(({ url }) => {
			if (!isWebview && isSafeExternalUrl(url)) shell.openExternal(url)
			return { action: 'deny' }
		})

		if (isWebview) return

		contents.on('will-navigate', (event, url) => {
			if (!isAppUrl(url)) event.preventDefault()
		})

		contents.on('will-attach-webview', (event, webPreferences, params) => {
			delete webPreferences.preload
			webPreferences.nodeIntegration = false
			webPreferences.nodeIntegrationInSubFrames = false
			webPreferences.contextIsolation = true
			// A webview partition, whatever its tag says (its hubby's, or the former shared one), set
			// up before the guest loads (its way out, its blocklist, its integrations):
			// webPreferences decide the guest's session (params.partition is only read).
			const partition = webviewPartition(params.partition)
			webSession(partition)
			webPreferences.partition = partition
			params.partition = partition

			const src = params.src ?? ''
			if (src !== '' && src !== 'about:blank' && !/^https?:\/\//i.test(src)) {
				event.preventDefault()
			}
		})
	})

	app.whenReady().then(() => {
		hardenSession(session.defaultSession)
		hardenSession(webSession(BROWSE_PARTITION))
	})
}
