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

/** A module's badge: the sum of its notifications' counts (an event counts as one). */
export function moduleCount(list: AppNotification[], module: string): number {
	return list.filter(n => n.module === module).reduce((sum, n) => sum + (n.count ?? 1), 0)
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

type Opening = { at: number, module: string | null }
let opening: Opening | null = null
const openingListeners = new Set<() => void>()

/** Opens the notifications menu, scrolled to a module's when given. */
export function openNotifications(module: string | null = null): void {
	opening = { at: Date.now(), module }
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

/** Reads the list and (re)connects to the hub, or polls without one. */
async function connect(): Promise<void> {
	stream?.abort()
	stream = null
	if (renewTimer) clearTimeout(renewTimer)
	let live: Live | null
	try {
		live = await load()
	}
	catch (err) {
		console.warn('[notifications] not read', err)
		retryLater()
		return
	}
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
