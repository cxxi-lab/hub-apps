import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'
import { windowBackground } from '../app/theme'

const isDev = !app.isPackaged

let aboutWindow: BrowserWindow | null = null

export function openAboutWindow(): void {
	if (aboutWindow && !aboutWindow.isDestroyed()) {
		aboutWindow.focus()
		return
	}

	const parent = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
	aboutWindow = new BrowserWindow({
		backgroundColor: windowBackground(),
		width: 420,
		height: 340,
		title: 'About',
		icon: appIcon,
		parent,
		modal: false,
		resizable: false,
		minimizable: false,
		maximizable: false,
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			preload: join(__dirname, '../preload/index.cjs'),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false
		}
	})

	aboutWindow.setMenuBarVisibility(false)
	aboutWindow.on('ready-to-show', () => aboutWindow?.show())
	aboutWindow.on('closed', () => { aboutWindow = null })

	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		aboutWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=about`)
	}
	else {
		aboutWindow.loadFile(join(__dirname, '../renderer/index.html'), {
			query: { window: 'about' }
		})
	}
}

ipcMain.handle('about:open', () => openAboutWindow())
