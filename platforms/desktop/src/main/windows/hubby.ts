import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'
import { windowBackground } from '../app/theme'

/**
 * Windows of the hubbies (HubbyManifest.windows). The host knows nothing of them but what the
 * main window registers for the active hubbies: an id, a title, a size, a menu entry. The window
 * loads the app with `?window=hubby&hubby=<id>&id=<window>`, which renders the hubby's component.
 */
export interface HubbyWindowInfo {
	hubbyId: string
	id: string
	title: string
	width?: number
	height?: number
	menu?: { label: string, accelerator?: string }
}

const isDev = !app.isPackaged
const ID = /^[a-z0-9-]{1,40}$/

let registered: HubbyWindowInfo[] = []
const open = new Map<string, BrowserWindow>()
const listeners = new Set<() => void>()

export function hubbyWindows(): HubbyWindowInfo[] {
	return registered
}

/** Called back when the registered windows change (the app menu rebuilds). */
export function onHubbyWindowsChange(cb: () => void): void {
	listeners.add(cb)
}

export function openHubbyWindow(hubbyId: string, windowId: string): void {
	const info = registered.find(w => w.hubbyId === hubbyId && w.id === windowId)
	if (!info) return // not an active hubby's window
	const key = `${hubbyId}/${windowId}`
	const existing = open.get(key)
	if (existing && !existing.isDestroyed()) {
		existing.focus()
		return
	}

	const parent = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
	const window = new BrowserWindow({
		backgroundColor: windowBackground(),
		width: info.width ?? 960,
		height: info.height ?? 640,
		title: info.title,
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
	open.set(key, window)
	window.setMenuBarVisibility(false)
	window.on('ready-to-show', () => window.show())
	window.on('closed', () => open.delete(key))

	const query = { window: 'hubby', hubby: hubbyId, id: windowId }
	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
	}
	else {
		window.loadFile(join(__dirname, '../renderer/index.html'), { query })
	}
}

function valid(w: unknown): w is HubbyWindowInfo {
	const v = w as HubbyWindowInfo
	return typeof v === 'object' && v !== null && ID.test(v.hubbyId) && ID.test(v.id) && typeof v.title === 'string'
		&& (v.width === undefined || Number.isInteger(v.width)) && (v.height === undefined || Number.isInteger(v.height))
		&& (v.menu === undefined || (typeof v.menu.label === 'string' && (v.menu.accelerator === undefined || typeof v.menu.accelerator === 'string')))
}

ipcMain.handle('hubby-windows:register', (_event, windows: unknown) => {
	registered = Array.isArray(windows) ? windows.filter(valid).map(w => ({ ...w, title: w.title.slice(0, 80) })) : []
	// a window of a hubby no longer active closes
	for (const [key, window] of open) {
		if (!registered.some(w => `${w.hubbyId}/${w.id}` === key) && !window.isDestroyed()) window.close()
	}
	listeners.forEach(cb => cb())
})

ipcMain.handle('hubby-window:open', (_event, hubbyId: string, windowId: string) => openHubbyWindow(String(hubbyId), String(windowId)))
