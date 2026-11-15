import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { initIcon, setIconAccent } from './icon'
import { ACCENT, storedTheme, storeTheme, type Mode } from './themeFile'

/**
 * The theme on the shell's side (the app chooses it, core/theme/theme.ts): the native theme (menus,
 * dialogs, the system's `prefers-color-scheme` the app reads in auto), the windows' background
 * before their page paints, and the icon in the accent colour — kept in a file, so that the next
 * start opens in the right colours.
 */

/** the page's colour in each theme (steel-900) */
const BACKGROUND = { dark: '#1c1f24', light: '#f3f4f6' } as const

const source = (mode: Mode) => mode === 'auto' ? 'system' : mode

/** The background a new window starts with. */
export const windowBackground = (): string => nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light

export function setupTheme(): void {
	initIcon()
	nativeTheme.themeSource = source(storedTheme().mode)
	ipcMain.on('theme:set', (_event, mode: unknown, theme: unknown, accent: unknown) => {
		if (mode !== 'auto' && mode !== 'light' && mode !== 'dark') return
		const colour = typeof accent === 'string' && ACCENT.test(accent) ? accent : 'blue'
		const before = storedTheme()
		if (before.mode !== mode || before.accent !== colour) storeTheme(mode, colour)
		setIconAccent(colour)
		nativeTheme.themeSource = source(mode)
		const color = theme === 'light' ? BACKGROUND.light : BACKGROUND.dark
		for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(color)
	})
}
