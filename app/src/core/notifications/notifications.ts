import { useSyncExternalStore } from 'react'
import { api } from '@core/api/client'
import { readEventStream } from '@core/api/stream'

/**
 * The user's notifications, for the whole app: the top-right menu lists them, each module's tab in
 * the top bar shows its count. Kept live: read once, then every change pushed by the server comes
 * through its real-time hub (Mercure, a private topic per user); without a hub, read again every
 * minute. Read again too when the window comes back, and after the stream was cut (nothing missed).
 */

export interface AppNotification {
	id: number
	/** the hubby's id (a field of the server's API, named `module` until the routes are reviewed) */
	module: string
	/** a state's key (e.g. a mailbox's unread count, updated in place); null: an event */
	key: string | null
	title: string
	body: string | null
	/** a state's count; null: counts as one */
	count: number | null
	/** where it leads in the app */
	link: string | null
	createdAt: string
	updatedAt: string
}

interface Live {
	hub: string
	topic: string
	token: string
	/** seconds */
	expiresIn: number
}

type ServerEvent =
	| { type: 'upsert', notification: AppNotification }
	| { type: 'remove', id: number }
	| { type: 'reload' }
	/** a local-first module's data got new operations (docs/plan-local-first.md § 3.4) */
	| { type: 'sync', module: string, position: number }
	/** a sealed message from another session of the account, for one of them (core/ai/remote.ts) */
	| { type: 'relay', from: string, to: string, sealed: string }
	/** a hubby's new version was published: the store looks now (core/hubby/HubbyUpdates.tsx) */
	| { type: 'hubbies' }

const hubbiesListeners = new Set<() => void>()

/** Called when the server says a hubby's new version was published. */
export function onHubbiesEvent(listener: () => void): () => void {
	hubbiesListeners.add(listener)
	return () => { hubbiesListeners.delete(listener) }
}

const relayListeners = new Set<(event: { from: string, to: string, sealed: string }) => void>()

/** Called with every relayed message on the account's topic (each for one session: the listener filters). */
export function onRelayEvent(listener: (event: { from: string, to: string, sealed: string }) => void): () => void {
	relayListeners.add(listener)
	return () => { relayListeners.delete(listener) }
}

const syncListeners = new Set<(module: string, position: number) => void>()

/** Called when the relay says a module has new operations (the sync engine listens). */
export function onSyncEvent(listener: (module: string, position: number) => void): () => void {
	syncListeners.add(listener)
	return () => { syncListeners.delete(listener) }
}

const POLL_MS = 60_000
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000]

let items: AppNotification[] = []
const listeners = new Set<() => void>()

function emit(next: AppNotification[]): void {
	items = next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id - a.id)
	for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
	listeners.add(cb)
	return () => { listeners.delete(cb) }
}

/** The notifications shown, newest first. */
export function useNotifications(): AppNotification[] {
	return useSyncExternalStore(subscribe, () => items)
}

/**
 * A notification of the app itself (never the server's: a hubby's update ready…), shown in the
 * same menu, on this device only. Its click runs `action`; its cross forgets it.
 */
export interface LocalNotification {
	/** unique among the app's own (e.g. `hubby-update:ai`) */
	key: string
	/** the hubby it is about (its icon and label in the menu) */
	hubby: string
	title: string
	body: string | null
	action: () => void
	createdAt: string
}

let locals: LocalNotification[] = []
const localListeners = new Set<() => void>()

/** Shows (or replaces) one of the app's own notifications; null: removes it. */
export function setLocalNotification(key: string, notification: Omit<LocalNotification, 'key' | 'createdAt'> | null): void {
	const existing = locals.find(n => n.key === key)
	const others = locals.filter(n => n.key !== key)
	locals = notification ? [{ ...notification, key, createdAt: existing?.createdAt ?? new Date().toISOString() }, ...others] : others
	localListeners.forEach(l => l())
}

/** The app's own notifications, newest first. */
export function useLocalNotifications(): LocalNotification[] {
	return useSyncExternalStore(l => { localListeners.add(l); return () => { localListeners.delete(l) } }, () => locals)
}

/** A module's badge: the sum of its notifications' counts (an event counts as one). */
export function hubbyCount(list: AppNotification[], hubby: string): number {
	return list.filter(n => n.module === hubby).reduce((sum, n) => sum + (n.count ?? 1), 0)
}

/** Its cross: an event goes, a state hides until it grows. */
export async function dismissNotification(id: number): Promise<void> {
	const previous = items
	emit(items.filter(n => n.id !== id))
	try {
		await api(`/api/hub/notifications/${id}`, { method: 'DELETE' })
	}
	catch (err) {
		console.warn('[notifications] not dismissed', err)
		emit(previous)
	}
}

// --- the menu, opened from elsewhere (a module's badge), on that module's notifications

type Opening = { at: number, hubby: string | null }
let opening: Opening | null = null
const openingListeners = new Set<() => void>()

/** Opens the notifications menu, scrolled to a module's when given. */
export function openNotifications(hubby: string | null = null): void {
	opening = { at: Date.now(), hubby }
	for (const cb of openingListeners) cb()
}

/** The last request to open the menu (the menu follows it). */
export function useNotificationsOpening(): Opening | null {
	return useSyncExternalStore(cb => { openingListeners.add(cb); return () => { openingListeners.delete(cb) } }, () => opening)
}

// --- keeping the list live

let started = false
let stream: AbortController | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let renewTimer: ReturnType<typeof setTimeout> | null = null
let failures = 0

async function load(): Promise<Live | null> {
	const res = await api<{ data: AppNotification[], live: Live | null }>('/api/hub/notifications')
	emit(res.data)
	return res.live
}

function apply(event: ServerEvent): void {
	if (event.type === 'upsert') {
		emit([...items.filter(n => n.id !== event.notification.id), event.notification])
	}
	else if (event.type === 'remove') {
		emit(items.filter(n => n.id !== event.id))
	}
	else if (event.type === 'sync') {
		syncListeners.forEach(listener => listener(event.module, event.position))
	}
	else if (event.type === 'relay') {
		relayListeners.forEach(listener => listener(event))
	}
	else if (event.type === 'hubbies') {
		hubbiesListeners.forEach(listener => listener())
	}
	else {
		void load().catch(() => {})
	}
}

/** Listens to the user's topic until cut; the token goes in a header (an EventSource can't). */
async function listen(live: Live, signal: AbortSignal): Promise<void> {
	const url = new URL(live.hub)
	url.searchParams.append('match', live.topic)
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${live.token}`, Accept: 'text/event-stream' },
		signal
	})
	if (!response.ok || !response.body) throw new Error(`hub: HTTP ${response.status}`)
	failures = 0
	await readEventStream(response.body, (_name, data) => apply(data as ServerEvent))
}

// each connect() a generation: one started meanwhile (or a stop) makes an earlier one give up — never
// two streams open at once (each event applied twice)
let generation = 0

/** Reads the list and (re)connects to the hub, or polls without one. */
async function connect(): Promise<void> {
	const mine = ++generation
	stream?.abort()
	stream = null
	if (renewTimer) clearTimeout(renewTimer)
	let live: Live | null
	try {
		live = await load()
	}
	catch (err) {
		if (mine !== generation) return
		console.warn('[notifications] not read', err)
		retryLater()
		return
	}
	if (mine !== generation || !started) return
	if (!live) {
		pollTimer ??= setInterval(() => { void load().catch(() => {}) }, POLL_MS)
		return
	}
	if (pollTimer) {
		clearInterval(pollTimer)
		pollTimer = null
	}
	// a fresh token before this one runs out
	renewTimer = setTimeout(() => { void connect() }, Math.max(60, live.expiresIn - 300) * 1000)
	const controller = new AbortController()
	stream = controller
	listen(live, controller.signal)
		.then(() => { if (stream === controller) retryLater() })
		.catch(err => {
			if (controller.signal.aborted) return
			console.warn('[notifications] stream cut', err)
			retryLater()
		})
}

function retryLater(): void {
	const delay = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]
	failures++
	setTimeout(() => { if (started) void connect() }, delay)
}

/** Starts keeping the list live (the main window, once signed in). Idempotent. */
export function startNotifications(): () => void {
	if (started) return () => {}
	started = true
	void connect()
	const onFocus = () => { void load().catch(() => {}) }
	window.addEventListener('focus', onFocus)
	return () => {
		started = false
		generation++
		window.removeEventListener('focus', onFocus)
		stream?.abort()
		stream = null
		if (pollTimer) clearInterval(pollTimer)
		if (renewTimer) clearTimeout(renewTimer)
		pollTimer = null
		renewTimer = null
		emit([])
	}
}
