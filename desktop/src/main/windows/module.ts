import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { appIcon } from '../app/icon'

/**
 * Windows of the modules (ModuleManifest.windows). The host knows nothing of them but what the
 * main window registers for the active modules: an id, a title, a size, a menu entry. The window
 * loads the app with `?window=module&module=<id>&id=<window>`, which renders the module's component.
 */
export interface ModuleWindowInfo {
	moduleId: string
	id: string
	title: string
	width?: number
	height?: number
	menu?: { label: string, accelerator?: string }
}

const isDev = !app.isPackaged
const ID = /^[a-z0-9-]{1,40}$/

let registered: ModuleWindowInfo[] = []
const open = new Map<string, BrowserWindow>()
const listeners = new Set<() => void>()

export function moduleWindows(): ModuleWindowInfo[] {
	return registered
}

/** Called back when the registered windows change (the app menu rebuilds). */
export function onModuleWindowsChange(cb: () => void): void {
	listeners.add(cb)
}

export function openModuleWindow(moduleId: string, windowId: string): void {
	const info = registered.find(w => w.moduleId === moduleId && w.id === windowId)
	if (!info) return // not an active module's window
	const key = `${moduleId}/${windowId}`
	const existing = open.get(key)
	if (existing && !existing.isDestroyed()) {
		existing.focus()
		return
	}

	const parent = BrowserWindow.getAllWindows().find(w => !w.isDestroyed())
	const window = new BrowserWindow({
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

	const query = { window: 'module', module: moduleId, id: windowId }
	if (isDev && process.env['ELECTRON_RENDERER_URL']) {
		window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${new URLSearchParams(query)}`)
	}
	else {
		window.loadFile(join(__dirname, '../renderer/index.html'), { query })
	}
}

function valid(w: unknown): w is ModuleWindowInfo {
	const v = w as ModuleWindowInfo
	return typeof v === 'object' && v !== null && ID.test(v.moduleId) && ID.test(v.id) && typeof v.title === 'string'
		&& (v.width === undefined || Number.isInteger(v.width)) && (v.height === undefined || Number.isInteger(v.height))
		&& (v.menu === undefined || (typeof v.menu.label === 'string' && (v.menu.accelerator === undefined || typeof v.menu.accelerator === 'string')))
}

ipcMain.handle('module-windows:register', (_event, windows: unknown) => {
	registered = Array.isArray(windows) ? windows.filter(valid).map(w => ({ ...w, title: w.title.slice(0, 80) })) : []
	// a window of a module no longer active closes
	for (const [key, window] of open) {
		if (!registered.some(w => `${w.moduleId}/${w.id}` === key) && !window.isDestroyed()) window.close()
	}
	listeners.forEach(cb => cb())
})

ipcMain.handle('module-window:open', (_event, moduleId: string, windowId: string) => openModuleWindow(String(moduleId), String(windowId)))
