import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'
import { windowBackground } from '../app/theme'

const isDev = !app.isPackaged

let updateWindow: BrowserWindow | null = null

/**
 * The window shown instead of the app while an update is pending: it offers the
 * update, then shows its download, verification and install.
 */
export function openUpdateWindow(): BrowserWindow {
	if (updateWindow && !updateWindow.isDestroyed()) {
		updateWindow.show()
		updateWindow.focus()
		return updateWindow
	}

	const win = new BrowserWindow({
		backgroundColor: windowBackground(),
		width: 460,
		height: 280,
		useContentSize: true,
		title: 'Update Hubbyware',
		icon: appIcon,
		center: true,
		resizable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false
		}
	})
	updateWindow = win

	win.setMenuBarVisibility(false)
	win.on('ready-to-show', () => {
		win.show()
		win.focus()
	})
	win.on('closed', () => { updateWindow = null })

	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=update`)
	}
	else {
		win.loadFile(join(__dirname, '../renderer/index.html'), {
			query: { window: 'update' }
		})
	}

	return win
}
