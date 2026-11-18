import { useEffect, useState } from 'react'
import { onBackDepth, handleBack } from '@cxxi-lab/hubbyware-ui'
import { PROTOCOL, type AppState, type CallError, type Envelope, type GuestMessage, type HostMessage, type HubbyPage, type TaskState } from '../protocol'

/**
 * The hubby SDK inside its frame (prototype): every call goes to the host by message and comes
 * back as a promise. The frame has no token, no cookie, no access to the app.
 */

/**
 * Non-2xx response (as in the app: `message` stays `HTTP <status>`, `detail` carries the server's
 * explanation when there is one).
 */
export class ApiError extends Error {
	readonly status: number
	readonly detail: string | null
	constructor(status: number, detail: string | null) {
		super(`HTTP ${status}`)
		this.name = 'ApiError'
		this.status = status
		this.detail = detail
	}
}

/** Best human-readable message for a caught error: server detail first. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
	if (err instanceof ApiError) return err.detail ?? err.message
	if (err instanceof Error) return err.message || fallback
	return fallback
}

function failureOf(error: string, failure?: CallError): Error {
	if (failure?.status !== undefined) return new ApiError(failure.status, failure.detail ?? null)
	return new Error(failure?.message ?? error)
}

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>()
const stateListeners = new Set<(state: AppState) => void>()
const streamListeners = new Map<number, (event: string, data: unknown) => void>()
const changeListeners = new Map<string, Set<(id: string) => void>>()
let appState: AppState = { phone: false, privateMode: false, visible: true, amountsBlurred: false, blurEpoch: 0, tunnelReady: true }
const initListeners = new Set<(init: Extract<HostMessage, { type: 'init' }>) => void>()
const pathListeners = new Set<(path: string) => void>()
const taskListeners = new Map<string, Set<(state: TaskState) => void>>()
let init: Extract<HostMessage, { type: 'init' }> | null = null

function post(message: GuestMessage) {
	const envelope: Envelope<GuestMessage> = { protocol: PROTOCOL, message }
	// the host's origin can't be checked from an opaque origin: '*', the host checks the source
	window.parent.postMessage(envelope, '*')
}

/** The app's theme and accent on this frame's root (the shared tokens are redefined under them). */
function applyTheme(theme: 'light' | 'dark' | undefined, accent: string | undefined) {
	const root = document.documentElement
	const value = theme ?? 'dark'
	root.dataset.theme = value
	root.style.colorScheme = value
	if (accent && accent !== 'blue') root.dataset.accent = accent
	else delete root.dataset.accent
}

const hostListeners = new Set<(m: HostMessage) => void>()

/** Called with each message of the host (the frame's other parts: the player, the surfaces). */
export function onHostMessage(listener: (m: HostMessage) => void): () => void {
	hostListeners.add(listener)
	return () => { hostListeners.delete(listener) }
}

window.addEventListener('message', event => {
	if (event.source !== window.parent) return
	const data = event.data as Envelope<HostMessage> | undefined
	if (data?.protocol !== PROTOCOL) return
	const m = data.message
	hostListeners.forEach(l => l(m))
	if (m.type === 'result') {
		const p = pending.get(m.id)
		pending.delete(m.id)
		if (!p) return
		if (m.ok) p.resolve(m.value)
		else p.reject(failureOf(m.error, m.failure))
	}
	else if (m.type === 'init') {
		applyTheme(m.theme, m.accent)
		init = m
		initListeners.forEach(l => l(m))
	}
	else if (m.type === 'back') handleBack()
	else if (m.type === 'path') pathListeners.forEach(l => l(m.path))
	else if (m.type === 'theme') applyTheme(m.theme, m.accent)
	else if (m.type === 'task') taskListeners.get(m.task.id)?.forEach(l => l(m.task))
	else if (m.type === 'state') {
		appState = m.state
		stateListeners.forEach(l => l(m.state))
	}
	else if (m.type === 'stream') streamListeners.get(m.stream)?.(m.event, m.data)
	else if (m.type === 'changed') changeListeners.get(m.collection)?.forEach(l => l(m.doc))
})

/** The app's state, for this hubby (pushed by the host). */
export function useAppState(): AppState {
	const [value, setValue] = useState(appState)
	useEffect(() => {
		stateListeners.add(setValue)
		setValue(appState)
		return () => { stateListeners.delete(setValue) }
	}, [])
	return value
}

/** A request's options as they cross to the host: a JSON or text body, plain headers. */
function plainOptions(options: RequestInit = {}): { method?: string, headers?: Record<string, string>, body?: string } {
	if (options.body !== undefined && options.body !== null && typeof options.body !== 'string') {
		throw new Error('a hubby\'s request body is a string (JSON): files go through the host')
	}
	const headers: Record<string, string> = {}
	new Headers(options.headers ?? {}).forEach((value, key) => { headers[key] = value })
	return { method: options.method, headers, body: (options.body as string | null | undefined) ?? undefined }
}

/** A call to the server's API, as the hubby (the host makes it): its JSON, an ApiError otherwise. */
export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
	return call<T>('api', path, plainOptions(options))
}

let nextStream = 1

/** A server-sent event stream, as the hubby (the host reads it): resolves once it ends. */
export async function apiStream(path: string, options: RequestInit, onEvent: (event: string, data: unknown) => void): Promise<void> {
	const id = nextStream++
	const signal = options.signal
	const abort = () => { void call('stream.abort', id) }
	streamListeners.set(id, onEvent)
	signal?.addEventListener('abort', abort)
	try {
		if (signal?.aborted) return
		const { signal: _signal, ...rest } = options
		await call('stream.open', id, path, plainOptions(rest))
	}
	finally {
		streamListeners.delete(id)
		signal?.removeEventListener('abort', abort)
	}
}

/** Called with a document's id each time one of the collection changes (here or elsewhere). */
export function watchCollection(name: string, listener: (id: string) => void): () => void {
	let set = changeListeners.get(name)
	if (!set) {
		changeListeners.set(name, set = new Set())
		void call('collection.watch', name)
	}
	set.add(listener)
	return () => {
		set.delete(listener)
		if (set.size === 0) {
			changeListeners.delete(name)
			void call('collection.unwatch', name)
		}
	}
}

/** A call to the host (the platform API, through it). */
export function call<T>(method: string, ...args: unknown[]): Promise<T> {
	const id = nextId++
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
		post({ type: 'call', id, method, args })
	})
}

/** The host's `init`, as received (null before it). */
export function currentInit(): Extract<HostMessage, { type: 'init' }> | null {
	return init
}

export function useInit() {
	const [value, setValue] = useState(init)
	useEffect(() => {
		initListeners.add(setValue)
		setValue(init) // it may have come before this component listened
		return () => { initListeners.delete(setValue) }
	}, [])
	return value
}

export function usePath(): string {
	const [path, setPath] = useState(init?.path ?? '/')
	useEffect(() => {
		pathListeners.add(setPath)
		const onInit = (m: { path: string }) => setPath(m.path)
		initListeners.add(onInit)
		if (init) setPath(init.path)
		return () => { pathListeners.delete(setPath); initListeners.delete(onInit) }
	}, [])
	return path
}

export const nav = {
	navigate(path: string) {
		post({ type: 'navigate', path })
	}
}

export interface Doc { id: string, [field: string]: unknown }

/** A collection of the hubby (the generic API, through the host). */
export function collection(name: string) {
	return {
		find: () => call<Doc[]>('collection.find', name),
		create: (doc: Record<string, unknown>) => call<Doc>('collection.create', name, doc),
		remove: (id: string) => call<void>('collection.remove', name, id)
	}
}

export const settings = {
	/** a real API call made by the host (measures a network round trip) */
	account: () => call<Record<string, unknown>>('settings.account')
}

export const notifications = {
	upsert: (n: { key: string, title: string, body?: string }) => call<void>('notifications.upsert', n)
}

/** Announces the hubby's pages to its host (it builds the navigation). */
/** An account connected at a provider, as the hubby sees it (its grant covers what it declares: `ready`). */
export interface OAuthConnection { id: string, provider: string, email: string, name: string | null, ready: boolean, lastError: string | null }

/**
 * The account's connections at a provider (Google, Microsoft), for what the hubby declares
 * (hubby.json `oauth`; the account allowing it `app:oauth:<provider>`): through the host, as the hubby.
 */
export const oauth = {
	connections: () => call<OAuthConnection[]>('oauth.connections'),
	/**
	 * the consent opens in the browser; resolves once the account consented. `signal`: stops
	 * waiting here (an AbortSignal can't cross to the host: the consent page stays open there)
	 */
	connect: (provider: string, options: { connection?: string, signal?: AbortSignal } = {}) => {
		const { signal, ...rest } = options
		const consented = call<OAuthConnection | null>('oauth.connect', provider, rest)
		if (!signal) return consented
		return Promise.race([consented, new Promise<never>((_, reject) => {
			const abort = () => reject(new DOMException('The connection was cancelled', 'AbortError'))
			if (signal.aborted) abort()
			else signal.addEventListener('abort', abort, { once: true })
		})])
	},
	/** an access token, for the hubby's scopes only */
	accessToken: (connection: string) => call<{ accessToken: string, expiresAt: number }>('oauth.accessToken', connection),
}

export type { TaskState }

const finished = (state: TaskState) => state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled'

/** A task of the hubby, through its host: followed by a hook or a stream, then its result. */
export interface Task {
	readonly id: string
	readonly state: TaskState
	on(listener: (state: TaskState) => void): () => void
	events(signal?: AbortSignal): AsyncIterableIterator<TaskState>
	result<T>(): Promise<T>
	cancel(): Promise<TaskState>
}

function frameTask(initial: TaskState): Task {
	let state = initial
	const on = (listener: (state: TaskState) => void) => {
		listener(state)
		if (finished(state)) return () => {}
		let set = taskListeners.get(state.id)
		if (!set) {
			taskListeners.set(state.id, set = new Set())
			void call('tasks.follow', state.id)
		}
		const wrapped = (next: TaskState) => { state = next; listener(next) }
		set.add(wrapped)
		return () => {
			set.delete(wrapped)
			if (set.size === 0) {
				taskListeners.delete(state.id)
				void call('tasks.unfollow', state.id)
			}
		}
	}
	return {
		id: state.id,
		get state() { return state },
		on,
		async *events(signal?: AbortSignal) {
			const queue: TaskState[] = []
			let wake: (() => void) | null = null
			const stop = on(s => { queue.push(s); wake?.() })
			const abort = () => wake?.()
			signal?.addEventListener('abort', abort)
			try {
				while (!signal?.aborted) {
					if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
					wake = null
					while (queue.length > 0) {
						const s = queue.shift()!
						yield s
						if (finished(s)) return
					}
				}
			}
			finally {
				stop()
				signal?.removeEventListener('abort', abort)
			}
		},
		result: <T>() => call<T>('tasks.result', state.id),
		cancel: async () => (state = await call<TaskState>('tasks.cancel', state.id))
	}
}

/**
 * The hubby's tasks (server docs/plan-tasks.md): a capability's call (/api/cap/…) run in the
 * background by the host, as the hubby; followed live, its result read once finished.
 */
export const tasks = {
	/** `options`: the call's method, JSON body (a string) and headers */
	start: async (path: string, options: { method?: string, body?: string, headers?: Record<string, string> } = {}) =>
		frameTask(await call<TaskState>('tasks.start', path, options)),
	get: async (id: string) => frameTask(await call<TaskState>('tasks.get', id)),
	list: (status?: TaskState['status']) => call<TaskState[]>('tasks.list', status)
}

export function register(pages: HubbyPage[], sections: Record<string, unknown>) {
	post({ type: 'register', pages, sections })
}

/** Wires the frame to its host: ready, back depth, keys the app listens to (Ctrl+Alt…). */
export function connect() {
	onBackDepth(depth => post({ type: 'back-depth', depth }))
	window.addEventListener('keydown', e => {
		if (e.ctrlKey || e.altKey || e.metaKey) {
			post({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
		}
	})
	post({ type: 'ready', at: performance.now() })
}
