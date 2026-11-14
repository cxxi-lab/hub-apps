import { app, BrowserWindow, ipcMain, webContents } from 'electron'

export const isDev = !app.isPackaged

// Dev mode (which API the app talks to: local vs prod) follows whether this is a
// packaged build, NOT the build's Vite mode. `electron-vite preview` is a *prod build*
// run locally, so keying off import.meta.env / a run script left preview pointing at
// prod; app.isPackaged is the real "is this a shipped AppImage" signal. The tray menu
// still toggles it at runtime.
let _devMode = isDev
/** the hidden modules revealed this session (their shortcut), until Ctrl+Alt+Q or a restart */
let _revealed: string[] = []
let _appMuted = true

export const getDevMode = (): boolean => _devMode
export const getRevealedModules = (): string[] => _revealed
export const getAppMuted = (): boolean => _appMuted

export function setDevMode(value: boolean): void {
	if (_devMode === value) return
	_devMode = value
	broadcastDevMode()
}

export function setRevealedModules(ids: string[]): void {
	const next = [...new Set(ids.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,40}$/.test(id)))].sort()
	if (next.join() === _revealed.join()) return
	_revealed = next
	broadcastRevealedModules()
}

export function setAppMuted(value: boolean): void {
	if (_appMuted === value) return
	_appMuted = value
	applyMutedToAll()
	broadcastMuted()
}

function broadcastDevMode(): void {
	BrowserWindow.getAllWindows().forEach(w => w.webContents.send('dev-mode:changed', _devMode))
}

function broadcastRevealedModules(): void {
	BrowserWindow.getAllWindows().forEach(w => w.webContents.send('revealed-modules:changed', _revealed))
}

function broadcastMuted(): void {
	BrowserWindow.getAllWindows().forEach(w => w.webContents.send('audio:muted:changed', _appMuted))
}

function applyMutedToAll(): void {
	for (const wc of webContents.getAllWebContents()) {
		try { wc.setAudioMuted(_appMuted) } catch (err) { console.warn('[mute] setAudioMuted failed', err) }
	}
}

ipcMain.handle('dev-mode:get', () => _devMode)
ipcMain.handle('revealed-modules:get', () => _revealed)
ipcMain.on('revealed-modules:set', (_, ids: unknown) => { if (Array.isArray(ids)) setRevealedModules(ids) })
ipcMain.handle('audio:muted:get', () => _appMuted)
ipcMain.on('audio:muted:set', (_, value: boolean) => setAppMuted(value))
