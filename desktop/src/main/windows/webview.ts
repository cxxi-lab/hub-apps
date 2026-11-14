import { app, BrowserWindow } from 'electron'
import { getAppMuted } from '../app/state'
import { stripTrustedTypesCsp } from '../session/sessions'

// Keys forwarded from webviews to the host so the modules' reveal shortcuts (Ctrl+Alt + letters or
// digits) and Ctrl+Alt+Q (hide them all) work there too. No native default to suppress (so we
// always forward, never preventDefault).
const WEBVIEW_FORWARD_KEY = /^[a-z0-9]$/

export function installWebviewHandlers(): void {
	app.on('web-contents-created', (_event, contents) => {

		try { contents.setAudioMuted(getAppMuted()) } catch (err) { console.warn('[mute] setAudioMuted failed', err) }

		if (contents.getType() !== 'webview') return

		stripTrustedTypesCsp(contents.session)

		contents.on('dom-ready', () => {
			try { contents.setAudioMuted(getAppMuted()) } catch (err) { console.warn('[mute] webview setAudioMuted failed', err) }
		})

		contents.on('leave-html-full-screen', () => {
			for (const win of BrowserWindow.getAllWindows()) {
				win.setAutoHideMenuBar(false)
				win.setMenuBarVisibility(true)
				if (win.isFullScreen()) win.setFullScreen(false)
				setTimeout(() => win.setMenuBarVisibility(true), 50)
			}
		})

		contents.on('before-input-event', (_event, input) => {

			if (input.type !== 'keyDown') return
			if (!input.control || !input.alt) return

			const key = input.key.toLowerCase()
			if (!WEBVIEW_FORWARD_KEY.test(key)) return

			contents.hostWebContents?.send('webview-key', {
				key: input.key,
				ctrl: input.control,
				alt: input.alt
			})
		})
	})
}
