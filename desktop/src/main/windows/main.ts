import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'

const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null
// Closing the window only hides it (the app keeps running in the tray); a real quit
// (tray menu, Window > Quit, update…) sets this first so the window can actually close.
let quitting = false
app.on('before-quit', () => { quitting = true })

export function createWindow(): void {

	const win = new BrowserWindow({
		width: 1280,
		height: 800,
		icon: appIcon,
		show: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			webviewTag: true
		}
	})
	mainWindow = win

	win.on('ready-to-show', () => {
		if (!appIcon.isEmpty()) win.setIcon(appIcon)
		win.show()
	})

	win.on('close', event => {
		if (quitting) return
		event.preventDefault()
		win.hide()
	})
	win.on('closed', () => {
		if (mainWindow === win) mainWindow = null
	})

	const restoreMenuBar = () => {
		win.setAutoHideMenuBar(false)
		win.setMenuBarVisibility(true)
		if (win.isFullScreen()) win.setFullScreen(false)
		setTimeout(() => win.setMenuBarVisibility(true), 50)
	}

	win.webContents.on('leave-html-full-screen', restoreMenuBar)
	win.on('leave-full-screen', restoreMenuBar)

	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		win.loadURL(process.env['ELECTRON_RENDERER_URL'])
		// Docked: device mode (Ctrl+Shift+M) draws its phone frame only in the window.
		win.webContents.openDevTools({ mode: 'right' })

	} else {
		win.loadFile(join(__dirname, '../renderer/index.html'))
	}
}

/** Brings the main window back from the tray (or creates it if it was never opened). */
export function showMainWindow(): void {
	if (!mainWindow) return createWindow()
	if (mainWindow.isMinimized()) mainWindow.restore()
	mainWindow.show()
	mainWindow.focus()
}

/** A message to the main window's page, when it is there. */
export function sendToMainWindow(channel: string, ...args: unknown[]): void {
	if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

export function isMainWindowVisible(): boolean {
	return mainWindow?.isVisible() ?? false
}

export function hideMainWindow(): void {
	mainWindow?.hide()
}
