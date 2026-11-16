import { platform } from '@platform'

/**
 * Which modules are local-first on this device (docs/plan-local-first.md), wherever there is a local
 * base (desktop, Android):
 *  - the migrated ones (§ 6 step 3), on every device: the server's copy (Mongo) is read once to
 *    catch up, then no longer written;
 *  - the ones on trial, a list kept by the device (Settings › Developer): the server's copy is kept
 *    up to date too.
 */

const KEY = 'hub.localFirst'

/** Local-first everywhere: their server collections are read-only, then emptied. */
export const MIGRATED: readonly string[] = ['planner', 'workout', 'proto', 'nsfw', 'business']

export function localFirstModules(): string[] {
	try {
		const list = JSON.parse(localStorage.getItem(KEY) ?? '[]')
		return Array.isArray(list) ? list.filter((m): m is string => typeof m === 'string' && !MIGRATED.includes(m)) : []
	}
	catch {
		return []
	}
}

export const localFirstAvailable = (): boolean => platform.localStore !== null

export const isMigrated = (module: string): boolean => MIGRATED.includes(module)

/** On trial here: local-first, and its writes still copied to the server's collections. */
export const onTrial = (module: string): boolean => localFirstAvailable() && !isMigrated(module) && localFirstModules().includes(module)

export const isLocalFirst = (module: string): boolean => localFirstAvailable() && (isMigrated(module) || localFirstModules().includes(module))

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
