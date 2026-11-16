import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The theme kept for the next start (theme.ts writes it; icon.ts reads the accent): no imports of theirs. */
export type Mode = 'auto' | 'light' | 'dark'

const FILE = () => join(app.getPath('userData'), 'theme.json')
export const ACCENT = /^[a-z]{1,20}$/

export function storedTheme(): { mode: Mode, accent: string } {
	try {
		if (!existsSync(FILE())) return { mode: 'dark', accent: 'blue' }
		const { mode, accent } = JSON.parse(readFileSync(FILE(), 'utf8')) ?? {}
		return {
			mode: mode === 'light' || mode === 'auto' ? mode : 'dark',
			accent: typeof accent === 'string' && ACCENT.test(accent) ? accent : 'blue',
		}
	}
	catch {
		return { mode: 'dark', accent: 'blue' }
	}
}

export function storeTheme(mode: Mode, accent: string): void {
	try {
		writeFileSync(FILE(), JSON.stringify({ mode, accent }))
	}
	catch { /* the next start opens in the default colours: no harm */ }
}
