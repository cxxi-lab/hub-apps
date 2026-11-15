import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The theme on the shell's side (the app chooses it, core/theme/theme.ts): the native theme (menus,
 * dialogs, the system's `prefers-color-scheme` the app reads in auto), and the windows' background
 * before their page paints — kept in a file, so that the next start opens in the right colours.
 */

type Mode = 'auto' | 'light' | 'dark'

const FILE = () => join(app.getPath('userData'), 'theme.json')
/** the page's colour in each theme (steel-900) */
const BACKGROUND = { dark: '#1c1f24', light: '#f3f4f6' } as const

function read(): Mode {
	try {
		if (!existsSync(FILE())) return 'dark'
		const mode = JSON.parse(readFileSync(FILE(), 'utf8'))?.mode
		return mode === 'light' || mode === 'auto' ? mode : 'dark'
	}
	catch {
		return 'dark'
	}
}

const source = (mode: Mode) => mode === 'auto' ? 'system' : mode

/** The background a new window starts with. */
export const windowBackground = (): string => nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light

export function setupTheme(): void {
	nativeTheme.themeSource = source(read())
	ipcMain.on('theme:set', (_event, mode: unknown, theme: unknown) => {
		if (mode !== 'auto' && mode !== 'light' && mode !== 'dark') return
		if (read() !== mode) {
			try {
				writeFileSync(FILE(), JSON.stringify({ mode }))
			}
			catch { /* the next start opens in the system's colours: no harm */ }
		}
		nativeTheme.themeSource = source(mode)
		const color = theme === 'light' ? BACKGROUND.light : BACKGROUND.dark
		for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(color)
	})
}
