import { useSyncExternalStore } from 'react'
import { platform } from '@platform'
import { setLocalNotification } from '@core/notifications/notifications'
import { HUBBY_MANIFESTS, hubbyHomePath, reloadHubby } from './registry'

/**
 * Hubbies update themselves (asked by the user, 2026-11-18): a newer version downloaded in the
 * background is switched to as soon as it is ready — an isolated hubby alone, its frame mounted
 * again, the app going on — never while it is open (it waits until it is left: nothing being done
 * there is cut). While it updates, its icon shows it (a dark veil leaving clockwise, as phones do)
 * and it can't be opened. Once done, a notification says so. A hubby running in the app gets its
 * new version at the next start. The open one's version ready: a notification offers it now (its
 * page reloads). Asked by the user (the tray's Check for updates): every one ready, the open one's too.
 */

export interface Updating {
	/** when it began (ms) */
	startedAt: number
	/** when it was done (ms), null while it runs */
	doneAt: number | null
}

let updating = new Map<string, Updating>()
const listeners = new Set<() => void>()

function set(id: string, value: Updating | null): void {
	const next = new Map(updating)
	if (value) next.set(id, value)
	else next.delete(id)
	updating = next
	listeners.forEach(l => l())
}

/** The hubbies updating now. */
export function useUpdating(): ReadonlyMap<string, Updating> {
	return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => updating)
}

export const isUpdating = (id: string): boolean => updating.has(id)

/** The veil's progress, 0 → 1: it eases towards 0.9 while the update runs, then completes. */
export function progressOf(u: Updating, now = Date.now()): number {
	const running = 0.9 * (1 - Math.exp(-(now - u.startedAt) / 700))
	if (u.doneAt === null) return running
	const at = 0.9 * (1 - Math.exp(-(u.doneAt - u.startedAt) / 700))
	return Math.min(1, at + (1 - at) * ((now - u.doneAt) / FINISH_MS))
}

/** How long the veil takes to leave once done; the least an update shows (a quick one isn't a flash). */
const FINISH_MS = 400
const LEAST_MS = 1200
const CHECK_EVERY_MS = 60_000

const labelOf = (id: string) => HUBBY_MANIFESTS.find(m => m.id === id)?.label ?? id

async function update(id: string): Promise<void> {
	const store = platform.hubbyStore
	if (!store || updating.has(id)) return
	const startedAt = Date.now()
	set(id, { startedAt, doneAt: null })
	try {
		const switched = await store.activate([id])
		if (!switched.length) throw new Error('nothing to switch to')
		const version = await reloadHubby(id)
		const wait = LEAST_MS - (Date.now() - startedAt)
		if (wait > 0) await new Promise(r => setTimeout(r, wait))
		set(id, { startedAt, doneAt: Date.now() })
		await new Promise(r => setTimeout(r, FINISH_MS))
		setLocalNotification(`hubby-updated:${id}`, {
			hubby: id,
			title: `${labelOf(id)} updated to ${version}`,
			body: null,
			action: () => {
				const m = HUBBY_MANIFESTS.find(known => known.id === id)
				if (m) window.location.hash = `#${hubbyHomePath(m)}`
			}
		})
	}
	catch (err) {
		console.warn(`[hubbies] ${id} not updated`, err)
	}
	finally {
		set(id, null)
	}
}

/**
 * Looks for the versions ready and updates the hubbies that can be (isolated, not open: `open`,
 * the hubby on screen). Called every minute, when the app comes back, and when the open hubby
 * changes (one left gets its update then).
 */
export async function runUpdates(open: string | null, options: { includeOpen?: boolean, report?: boolean } = {}): Promise<void> {
	const store = platform.hubbyStore
	if (!store) return
	let pending: string[]
	try {
		pending = await store.pending()
	}
	catch {
		return
	}
	const doing: Array<Promise<void>> = []
	for (const p of pending) {
		const [id, version] = p.split(' ')
		const m = HUBBY_MANIFESTS.find(known => known.id === id)
		if (!m?.isolated) continue
		if (id === open && !options.includeOpen) {
			// the one on screen: never cut off, offered
			setLocalNotification(`hubby-ready:${id}`, {
				hubby: id,
				title: `${labelOf(id)} ${version} is ready`,
				body: 'Update it now: its page reloads.',
				action: () => { setLocalNotification(`hubby-ready:${id}`, null); void update(id) }
			})
			continue
		}
		setLocalNotification(`hubby-ready:${id}`, null)
		doing.push(update(id))
	}
	if (options.report) {
		await Promise.all(doing)
		if (!doing.length) setLocalNotification('hubbies-checked', { hubby: open ?? '', title: 'Your hubbies are up to date', body: null, action: () => setLocalNotification('hubbies-checked', null) })
	}
}

/** The server said a version was published: the store looks now, then the ones ready are switched to. */
export async function checkNow(open: string | null): Promise<void> {
	const store = platform.hubbyStore
	if (!store?.check) return
	try { await store.check() }
	catch { return }
	await runUpdates(open)
}

export const UPDATE_CHECK_MS = CHECK_EVERY_MS
