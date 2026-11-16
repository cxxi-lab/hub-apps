import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'
import { windowBackground } from '../app/theme'

const isDev = !app.isPackaged

let settingsWindow: BrowserWindow | null = null

/** A screen to open on (e.g. 'hubbies/mail'), else wherever the window is. */
const TARGET = /^[a-z0-9-]+(\/[a-z0-9-]+)?$/

export function openSettingsWindow(target?: string): void {
	const screenTarget = typeof target === 'string' && TARGET.test(target) ? target : null
	if (settingsWindow && !settingsWindow.isDestroyed()) {
		if (screenTarget) settingsWindow.webContents.send('settings:goto', screenTarget)
		settingsWindow.focus()
		return
	}

	const parent = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
	// A small window (a sidebar and one form), within the screen it opens on.
	const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
	settingsWindow = new BrowserWindow({
		backgroundColor: windowBackground(),
		width: Math.min(800, area.width - 40),
		height: Math.min(600, area.height - 40),
		minWidth: 600,
		minHeight: 400,
		title: 'Settings',
		icon: appIcon,
		parent,
		modal: false,
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

	settingsWindow.setMenuBarVisibility(false)
	settingsWindow.on('ready-to-show', () => settingsWindow?.show())
	settingsWindow.on('closed', () => { settingsWindow = null })

	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		settingsWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?window=settings${screenTarget ? `&screen=${screenTarget}` : ''}`)
	}
	else {
		settingsWindow.loadFile(join(__dirname, '../renderer/index.html'), {
			query: screenTarget ? { window: 'settings', screen: screenTarget } : { window: 'settings' }
		})
	}
}

ipcMain.handle('settings:open', (_event, target?: string) => openSettingsWindow(target))
