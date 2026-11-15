import { useSyncExternalStore } from 'react'
import { platform } from '@platform'

/**
 * The theme: light or dark, or `auto` (the system's, followed live); dark by default. And the
 * accent colour, from a fixed palette (`data-accent`; the hub blue by default). Chosen per device (a phone and
 * a desktop needn't agree), shared by the device's windows (a `storage` event). Applied as
 * `data-theme` on the root element: the colour tokens are variables (styles/index.css), redefined
 * for light.
 */
export type ThemeMode = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

/** The accent colours (hub-ui styles/theme.css), the first the default: the hub blue. */
export const ACCENTS = [
	{ id: 'blue', label: 'Blue', color: '#579dff' },
	{ id: 'green', label: 'Green', color: '#2ecc71' },
	{ id: 'teal', label: 'Teal', color: '#1abc9c' },
	{ id: 'purple', label: 'Purple', color: '#9b59b6' },
	{ id: 'red', label: 'Red', color: '#e74c3c' },
	{ id: 'orange', label: 'Orange', color: '#e67e22' },
	{ id: 'yellow', label: 'Yellow', color: '#f1c40f' },
] as const
export type Accent = typeof ACCENTS[number]['id']

const KEY = 'hub.theme'
const ACCENT_KEY = 'hub.accent'
const listeners = new Set<() => void>()
const system = window.matchMedia('(prefers-color-scheme: dark)')

/** Dark until chosen otherwise: the app always was, whatever the system's setting. */
export function themeMode(): ThemeMode {
	const stored = localStorage.getItem(KEY)
	return stored === 'auto' || stored === 'light' ? stored : 'dark'
}

export function currentTheme(): Theme {
	const mode = themeMode()
	return mode === 'auto' ? (system.matches ? 'dark' : 'light') : mode
}

export function currentAccent(): Accent {
	const stored = localStorage.getItem(ACCENT_KEY)
	return ACCENTS.some(a => a.id === stored) ? stored as Accent : 'blue'
}

function apply(): void {
	const theme = currentTheme()
	const accent = currentAccent()
	const root = document.documentElement
	root.dataset.theme = theme
	root.style.colorScheme = theme
	// the blue has no attribute: the theme's own primary
	if (accent === 'blue') delete root.dataset.accent
	else root.dataset.accent = accent
	platform.setTheme(themeMode(), theme, accent)
	listeners.forEach(l => l())
}

export function setAccent(accent: Accent): void {
	localStorage.setItem(ACCENT_KEY, accent)
	apply()
}

export function setThemeMode(mode: ThemeMode): void {
	localStorage.setItem(KEY, mode)
	apply()
}

/** Applies the theme now (before the first render: no flash), then follows the system and the other windows. */
export function startTheme(): void {
	apply()
	system.addEventListener('change', () => { if (themeMode() === 'auto') apply() })
	window.addEventListener('storage', e => { if (e.key === KEY || e.key === ACCENT_KEY) apply() })
}

const subscribe = (listener: () => void) => {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/** The mode chosen, re-rendered when it changes. */
export const useThemeMode = (): ThemeMode => useSyncExternalStore(subscribe, themeMode)

/** The accent colour, re-rendered when it changes. */
export const useAccent = (): Accent => useSyncExternalStore(subscribe, currentAccent)

/** The theme shown (auto resolved). */
export const useTheme = (): Theme => useSyncExternalStore(subscribe, currentTheme)
