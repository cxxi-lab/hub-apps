import { ipcMain, Menu } from 'electron'
import { getDevMode, setDevMode } from './state'
import { engine } from '../companion/engine'
import { openAboutWindow } from '../windows/about'
import { hubbyWindows, onHubbyWindowsChange, openHubbyWindow } from '../windows/hubby'
import { openSettingsWindow } from '../windows/settings'

let _authenticated = false

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
				{
					// Neutral label on purpose: the companion lives in a private hubby.
					label: engine.getInfo().status === 'starting' ? 'Toggle AI Engine (starting…)' : 'Toggle AI Engine',
					type: 'checkbox',
					checked: engine.getInfo().status === 'on' || engine.getInfo().status === 'starting',
					click: () => void (engine.getInfo().status === 'off' || engine.getInfo().status === 'error' ? engine.start() : engine.stop())
				},
				{ type: 'separator' },
				// the windows of the active hubbies that ask for a menu entry
				...hubbyWindows().filter(w => w.menu).map<Electron.MenuItemConstructorOptions>(w => ({
					label: w.menu!.label,
					accelerator: w.menu!.accelerator,
					click: () => openHubbyWindow(w.hubbyId, w.id)
				})),
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

onHubbyWindowsChange(applyMenu)

ipcMain.on('auth:state-changed', (_, value: boolean) => {
	if (_authenticated === value) return
	_authenticated = value
	applyMenu()
})
