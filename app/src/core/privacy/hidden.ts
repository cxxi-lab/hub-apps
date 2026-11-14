import { useSyncExternalStore } from 'react'
import { api } from '@core/api/client'
import { platform } from '@platform'

/**
 * The modules hidden behind a reveal shortcut (Privacy, in each module's settings), and the ones
 * revealed this session. A hidden module doesn't show anywhere (top bar, home page, Modules, its
 * routes) until its shortcut, Ctrl+Alt + its keys (or /reveal on the phone), which only the server
 * knows: the keys typed are sent to it. Ctrl+Alt+Q hides them all again; a restart too.
 */

/** the last hidden list read, for the start (nothing hidden shows before the server answers) */
const CACHE = 'hub:hidden-modules'
const BLUR_CACHE = 'hub:blurred-modules'

let hidden: string[] = readCache()
let revealed: string[] = []
/** the modules whose amounts are blurred (Privacy) */
let blurred: string[] = readCache(BLUR_CACHE)
/** bumped by Ctrl+Alt+Q: the amounts shown one by one blur again */
let blurEpoch = 0
const listeners = new Set<() => void>()

function readCache(key = CACHE): string[] {
	try {
		const kept = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown
		return Array.isArray(kept) ? kept.filter((id): id is string => typeof id === 'string') : []
	}
	catch {
		return []
	}
}

function changed(): void {
	for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb)
	return () => { listeners.delete(cb) }
}

void platform.getRevealedModules().then(ids => { revealed = ids; changed() }).catch(() => {})
platform.onRevealedModulesChange(ids => { revealed = ids; changed() })

/** The account's hidden modules, as the server listed them (the modules state). */
export function setHiddenModules(ids: string[]): void {
	if (ids.join() === hidden.join()) return
	hidden = [...ids]
	try { localStorage.setItem(CACHE, JSON.stringify(hidden)) } catch { /* read again next time */ }
	changed()
}

/** The modules whose amounts are blurred, as the server listed them (the modules state). */
export function setBlurredModules(ids: string[]): void {
	if (ids.join() === blurred.join()) return
	blurred = [...ids]
	try { localStorage.setItem(BLUR_CACHE, JSON.stringify(blurred)) } catch { /* read again next time */ }
	changed()
}

/** Whether a module's amounts are blurred (its Privacy setting). */
export function useAmountsBlurred(module: string): boolean {
	return useSyncExternalStore(subscribe, () => blurred).includes(module)
}

/** Changes on Ctrl+Alt+Q: the amounts revealed one by one blur again. */
export function useBlurEpoch(): number {
	return useSyncExternalStore(subscribe, () => blurEpoch)
}

export function useHiddenModules(): string[] {
	return useSyncExternalStore(subscribe, () => hidden)
}

export function useRevealedModules(): string[] {
	return useSyncExternalStore(subscribe, () => revealed)
}

/** Whether a module shows: not hidden, or revealed this session. */
export function useModuleVisible(id: string): boolean {
	const all = useHiddenModules()
	const shown = useRevealedModules()
	return !all.includes(id) || shown.includes(id)
}

/**
 * Whether a hidden module is revealed this session (the former "private mode"): the players pause
 * when it turns false (Ctrl+Alt+Q). Kept for the modules built before useModuleVisible.
 */
export function usePrivateMode(): boolean {
	return useRevealedModules().length > 0
}

/** Reveals the hidden modules these keys open (the server matches them); the ids revealed. */
export async function reveal(keys: string): Promise<string[]> {
	const { data } = await api<{ data: string[] }>('/api/hub/privacy/reveal', { method: 'POST', body: JSON.stringify({ sequence: keys }) })
	if (data.length) platform.setRevealedModules([...revealed, ...data])
	return data
}

/** Ctrl+Alt+Q: hides every revealed module again, and mutes the app. */
export function hideAll(): void {
	platform.setRevealedModules([])
	platform.setMuted(true)
	blurEpoch++
	changed()
}
