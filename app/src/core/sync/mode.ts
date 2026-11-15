import { platform } from '@platform'

/**
 * Which modules are local-first on this device (docs/plan-local-first.md, the trial): a list kept
 * by the device (Settings › Developer), only where there is a local base (desktop for now).
 */

const KEY = 'hub.localFirst'

export function localFirstModules(): string[] {
	try {
		const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
		return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string') : []
	}
	catch {
		return []
	}
}

export const localFirstAvailable = (): boolean => platform.localStore !== null

export const isLocalFirst = (module: string): boolean => localFirstAvailable() && localFirstModules().includes(module)

/**
 * Turns it on or off here; the main window reloads to take it: from the Settings window (desktop),
 * by a `storage` event (engine.ts); Settings being a page of the main window (Android), at once.
 */
export function setLocalFirst(module: string, on: boolean): void {
	const list = new Set(localFirstModules())
	if (on) list.add(module)
	else list.delete(module)
	localStorage.setItem(KEY, JSON.stringify([...list]))
	if (new URLSearchParams(location.search).get('window') !== 'settings') location.reload()
}

export const LOCAL_FIRST_KEY = KEY
