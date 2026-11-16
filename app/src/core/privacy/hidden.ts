import { useSyncExternalStore } from 'react'
import { api } from '@core/api/client'
import { platform } from '@platform'

/**
 * The hubbies hidden behind a reveal shortcut (Privacy, in each hubby's settings), and the ones
 * revealed this session. A hidden hubby doesn't show anywhere (top bar, home page, Hubbies, its
 * routes) until its shortcut, Ctrl+Alt + its keys (or /reveal on the phone), which only the server
 * knows: the keys typed are sent to it. Ctrl+Alt+Q hides them all again; a restart too.
 */

/** the last hidden list read, for the start (nothing hidden shows before the server answers) */
const CACHE = 'hub:hidden-modules'
const BLUR_CACHE = 'hub:blurred-modules'

let hidden: string[] = readCache()
let revealed: string[] = []
/** the hubbies whose amounts are blurred (Privacy) */
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

void platform.getRevealedHubbies().then(ids => { revealed = ids; changed() }).catch(() => {})
platform.onRevealedHubbiesChange(ids => { revealed = ids; changed() })

/** The account's hidden hubbies, as the server listed them (the hubbies state). */
export function setHiddenHubbies(ids: string[]): void {
	if (ids.join() === hidden.join()) return
	hidden = [...ids]
	try { localStorage.setItem(CACHE, JSON.stringify(hidden)) } catch { /* read again next time */ }
	changed()
}

/** The hubbies whose amounts are blurred, as the server listed them (the hubbies state). */
export function setBlurredHubbies(ids: string[]): void {
	if (ids.join() === blurred.join()) return
	blurred = [...ids]
	try { localStorage.setItem(BLUR_CACHE, JSON.stringify(blurred)) } catch { /* read again next time */ }
	changed()
}

/** Whether a hubby's amounts are blurred (its Privacy setting). */
export function useAmountsBlurred(hubby: string): boolean {
	return useSyncExternalStore(subscribe, () => blurred).includes(hubby)
}

/** Changes on Ctrl+Alt+Q: the amounts revealed one by one blur again. */
export function useBlurEpoch(): number {
	return useSyncExternalStore(subscribe, () => blurEpoch)
}

export function useHiddenHubbies(): string[] {
	return useSyncExternalStore(subscribe, () => hidden)
}

export function useRevealedHubbies(): string[] {
	return useSyncExternalStore(subscribe, () => revealed)
}

/** Whether a hubby shows: not hidden, or revealed this session. */
export function useHubbyVisible(id: string): boolean {
	const all = useHiddenHubbies()
	const shown = useRevealedHubbies()
	return !all.includes(id) || shown.includes(id)
}

/**
 * Whether a hidden hubby is revealed this session (the former "private mode"): the players pause
 * when it turns false (Ctrl+Alt+Q). Kept for the hubbies built before useHubbyVisible.
 */
export function usePrivateMode(): boolean {
	return useRevealedHubbies().length > 0
}

/** Reveals the hidden hubbies these keys open (the server matches them); the ids revealed. */
export async function reveal(keys: string): Promise<string[]> {
	const { data } = await api<{ data: string[] }>('/api/hub/privacy/reveal', { method: 'POST', body: JSON.stringify({ sequence: keys }) })
	if (data.length) platform.setRevealedHubbies([...revealed, ...data])
	return data
}

/** Ctrl+Alt+Q: hides every revealed hubby again, and mutes the app. */
export function hideAll(): void {
	platform.setRevealedHubbies([])
	platform.setMuted(true)
	blurEpoch++
	changed()
}
