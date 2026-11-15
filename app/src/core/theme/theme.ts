import { useSyncExternalStore } from 'react'

/**
 * The theme: light or dark, or `auto` (the system's, followed live). Chosen per device (a phone and
 * a desktop needn't agree), shared by the device's windows (a `storage` event). Applied as
 * `data-theme` on the root element: the colour tokens are variables (styles/index.css), redefined
 * for light.
 */
export type ThemeMode = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

const KEY = 'hub.theme'
const listeners = new Set<() => void>()
const system = window.matchMedia('(prefers-color-scheme: dark)')

export function themeMode(): ThemeMode {
	const stored = localStorage.getItem(KEY)
	return stored === 'light' || stored === 'dark' ? stored : 'auto'
}

export function currentTheme(): Theme {
	const mode = themeMode()
	return mode === 'auto' ? (system.matches ? 'dark' : 'light') : mode
}

function apply(): void {
	const theme = currentTheme()
	document.documentElement.dataset.theme = theme
	document.documentElement.style.colorScheme = theme
	listeners.forEach(l => l())
}

export function setThemeMode(mode: ThemeMode): void {
	if (mode === 'auto') localStorage.removeItem(KEY)
	else localStorage.setItem(KEY, mode)
	apply()
}

/** Applies the theme now (before the first render: no flash), then follows the system and the other windows. */
export function startTheme(): void {
	apply()
	system.addEventListener('change', () => { if (themeMode() === 'auto') apply() })
	window.addEventListener('storage', e => { if (e.key === KEY) apply() })
}

const subscribe = (listener: () => void) => {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/** The mode chosen, re-rendered when it changes. */
export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, themeMode)

/** The theme shown (auto resolved). */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, currentTheme)
