import { BrowserWindow, ipcMain, session } from 'electron'
import { appIcon } from '../app/icon'
import { allowExternalNavigation } from '../app/security'

/**
 * OAuth consent pages (connecting a mailbox to Gmail or Microsoft): a plain, sandboxed window with no
 * preload, in its own partition (proxied through the VPN like the app), allowed to leave the app.
 * The provider ends by redirecting to a loopback address: that request is caught and cancelled (it
 * is never loaded) and its URL, which carries the code, goes back to the caller.
 */
export const OAUTH_PARTITION = 'persist:oauth'

let current: { window: BrowserWindow, settle: (url: string | null) => void } | null = null

export function authorize(url: string, redirectUri: string, parent: BrowserWindow | null): Promise<string | null> {
	if (!/^https:\/\//i.test(url) || !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(redirectUri)) {
		return Promise.reject(new Error('Unexpected OAuth addresses'))
	}
	current?.settle(null) // one consent at a time

	return new Promise(resolve => {
		const sess = session.fromPartition(OAUTH_PARTITION)
		const window = new BrowserWindow({
			width: 520,
			height: 720,
			title: 'Connect a mailbox',
			icon: appIcon,
			parent: parent ?? undefined,
			modal: false,
			minimizable: false,
			maximizable: false,
			autoHideMenuBar: true,
			webPreferences: { session: sess, sandbox: true, contextIsolation: true, nodeIntegration: false }
		})
		allowExternalNavigation(window.webContents)
		window.setMenuBarVisibility(false)

		let done = false
		const settle = (result: string | null) => {
			if (done) return
			done = true
			current = null
			sess.webRequest.onBeforeRequest(null)
			if (!window.isDestroyed()) window.close()
			resolve(result)
		}
		current = { window, settle }

		// A match pattern without a port matches every port.
		const host = new URL(redirectUri).hostname
		sess.webRequest.onBeforeRequest({ urls: [`http://${host}/*`] }, (details, callback) => {
			callback({ cancel: true })
			settle(details.url)
		})
		window.on('closed', () => settle(null))
		window.loadURL(url).catch(() => { /* a failed load shows in the window; closing it settles */ })
	})
}

ipcMain.handle('oauth:authorize', (event, url: string, redirectUri: string) =>
	authorize(url, redirectUri, BrowserWindow.fromWebContents(event.sender)))
