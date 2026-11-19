import { ipcMain, Menu } from 'electron'
import { getDevMode, setDevMode } from './state'
import { localEngine, type EngineInfo } from '../ai/engine'
import path from 'node:path'
import { openAboutWindow } from '../windows/about'
import { openSettingsWindow } from '../windows/settings'

let _authenticated = false

/** The local AI engine (client docs/plan-ia-moteur.md): what it is doing, and stopping it. */
function localAiItem(info: EngineInfo): Electron.MenuItemConstructorOptions {
	const state = info.status === 'downloading' ? `downloading${info.progress !== null ? ` ${Math.round(info.progress * 100)} %` : '…'}`
		: info.status === 'starting' ? 'starting…'
		: info.status === 'on' ? `on (${path.basename(info.model ?? '')})`
		: info.status === 'error' ? `error: ${info.error ?? 'unknown'}`
		: 'off'
	return {
		label: `Local AI: ${state}`,
		submenu: [{ label: 'Stop', enabled: info.status !== 'off', click: () => void localEngine.stop() }]
	}
}

function buildMenu(): Electron.Menu {
	const template: Electron.MenuItemConstructorOptions[] = [
		{
			label: 'Window',
			submenu: [
				{ role: 'reload', accelerator: 'F5' },
				{ type: 'separator' },
				{ role: 'toggleDevTools' },
				{
					label: 'Toggle Developer Local Mode',
					accelerator: 'CommandOrControl+Alt+L',
					click: () => setDevMode(!getDevMode())
				},
				localAiItem(localEngine.getInfo()),
				{ type: 'separator' },
				{
					label: 'Settings…',
					accelerator: 'CommandOrControl+,',
					click: () => openSettingsWindow()
				},
				{
					label: 'About…',
					click: () => openAboutWindow()
				},
				{ type: 'separator' },
				{ role: 'quit', accelerator: 'CommandOrControl+Shift+Q' }
			]
		},
		{
			label: 'Edit',
			submenu: [
				{ role: 'undo' },
				{ role: 'redo' },
				{ type: 'separator' },
				{ role: 'cut' },
				{ role: 'copy' },
				{ role: 'paste' },
				{ role: 'selectAll' }
			]
		}
	]
	return Menu.buildFromTemplate(template)
}

export function applyMenu(): void {
	Menu.setApplicationMenu(buildMenu())
}

ipcMain.on('auth:state-changed', (_, value: boolean) => {
	if (_authenticated === value) return
	_authenticated = value
	applyMenu()
})
