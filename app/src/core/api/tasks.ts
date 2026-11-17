import { read, send, taskOf, type Caller } from './client'
import { readEventStream } from './stream'

/**
 * A hubby's tasks (server docs/plan-tasks.md): a capability's call it runs in the background, and
 * follows by a hook (`task.on`) or a stream (`for await … of task.events()`), then reads its
 * result (`task.result()`: the response the call got, as the call itself would have given it).
 * The calls are the hubby's (its token): it sees its own tasks only.
 *
 * Live: the server publishes each change on the hubby's topic (Mercure, /api/cap/tasks/live), one
 * stream per hubby for all its tasks, open while some task is followed; without a hub, or while
 * it is cut, the followed tasks are polled.
 */

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface TaskProgress {
	done: number
	total: number | null
	message: string | null
	/** what the operation adds (its own shape: an import's job, its counts…) */
	data?: unknown
}

/** A task, as its hubby sees it. */
export interface TaskState {
	id: string
	/** the call: `POST /api/cap/…` */
	operation: string
	status: TaskStatus
	progress: TaskProgress | null
	/** finished: the status of the response its call got */
	httpStatus: number | null
	error: string | null
	createdAt: string
	startedAt: string | null
	finishedAt: string | null
}

export interface Task {
	readonly id: string
	/** its state as last heard */
	readonly state: TaskState
	/** Calls `listener` at each change (the current state first); gives back how to stop. */
	on(listener: (state: TaskState) => void): () => void
	/** Its changes, the current state first, until it is finished (or `signal` aborts). */
	events(signal?: AbortSignal): AsyncIterableIterator<TaskState>
	/**
	 * Once finished, what its call would have given: its JSON (an ApiError for a failed call, the
	 * operation's own error), a TaskCancelledError when cancelled.
	 */
	result<T>(): Promise<T>
	/** Cancels it: queued, at once; running, at the operation's next report. */
	cancel(): Promise<TaskState>
}

export interface TasksApi {
	/**
	 * Runs a capability's call as a task (`Prefer: respond-async`). An operation that can't run as
	 * one runs at once: the task given back is already finished, its result the call's.
	 */
	start(path: string, options?: RequestInit): Promise<Task>
	/** One of the hubby's tasks, by its id. */
	get(id: string): Promise<Task>
	/** The hubby's tasks, newest first (finished ones are kept 24 h). */
	list(status?: TaskStatus): Promise<TaskState[]>
}

export class TaskCancelledError extends Error {
	constructor(public readonly task: string) {
		super('The task was cancelled')
	}
}

const FINISHED: TaskStatus[] = ['succeeded', 'failed', 'cancelled']
export const isFinished = (state: TaskState): boolean => FINISHED.includes(state.status)

/** polled this often without the live stream, and once in a while with it (an event missed) */
export const timing = { poll: 2_000, check: 20_000 }
const RETRY_MS = [1_000, 3_000, 10_000, 30_000]

interface Live { hub: string, topic: string, token: string | null, expiresIn: number }

/** The live stream of one hubby's tasks, and the tasks it follows. */
class Watcher {
	private readonly listeners = new Map<string, Set<(state: TaskState) => void>>()
	private stream: AbortController | null = null
	private renew: ReturnType<typeof setTimeout> | null = null
	private poll: ReturnType<typeof setInterval> | null = null
	private live = false
	private failures = 0

	constructor(private readonly caller: Caller) {}

	async state(id: string): Promise<TaskState> {
		const response = await send(this.caller, `/api/cap/tasks/${id}`)
		return (await read<{ data: TaskState }>(response)).data
	}

	follow(id: string, listener: (state: TaskState) => void): () => void {
		let set = this.listeners.get(id)
		if (!set) this.listeners.set(id, set = new Set())
		set.add(listener)
		this.start()
		// what it is now (it may have changed before the stream was open)
		void this.state(id).then(state => this.emit(state)).catch(() => {})
		return () => {
			set.delete(listener)
			if (set.size === 0) this.listeners.delete(id)
			if (this.listeners.size === 0) this.stop()
		}
	}

	private emit(state: TaskState): void {
		this.listeners.get(state.id)?.forEach(listener => listener(state))
	}

	private start(): void {
		if (this.stream) return
		this.schedulePoll()
		void this.connect()
	}

	private stop(): void {
		this.stream?.abort()
		this.stream = null
		this.live = false
		if (this.renew) clearTimeout(this.renew)
		if (this.poll) clearInterval(this.poll)
		this.renew = this.poll = null
	}

	/** Polls the followed tasks: often without the stream, now and then with it. */
	private schedulePoll(): void {
		if (this.poll) clearInterval(this.poll)
		this.poll = setInterval(() => {
			for (const id of this.listeners.keys()) void this.state(id).then(state => this.emit(state)).catch(() => {})
		}, this.live ? timing.check : timing.poll)
	}

	private async connect(): Promise<void> {
		const controller = new AbortController()
		this.stream = controller
		let live: Live | null
		try {
			live = (await read<{ data: Live | null }>(await send(this.caller, '/api/cap/tasks/live'))).data
		}
		catch {
			this.retry(controller)
			return
		}
		if (controller.signal.aborted) return
		if (!live?.token) return // no hub: polled
		this.renew = setTimeout(() => { if (this.stream === controller) { controller.abort(); this.stream = null; this.start() } }, Math.max(60, live.expiresIn - 300) * 1000)
		try {
			const url = new URL(live.hub)
			url.searchParams.append('match', live.topic)
			const response = await fetch(url, { headers: { Authorization: `Bearer ${live.token}`, Accept: 'text/event-stream' }, signal: controller.signal })
			if (!response.ok || !response.body) throw new Error(`hub: HTTP ${response.status}`)
			this.failures = 0
			this.live = true
			this.schedulePoll()
			await readEventStream(response.body, (_name, data) => {
				const event = data as { type?: string, task?: TaskState }
				if (event.type === 'task' && event.task) this.emit(event.task)
			})
		}
		catch {
			// cut, or aborted
		}
		this.retry(controller)
	}

	/** The stream cut while tasks are followed: polled meanwhile, connected again a bit later. */
	private retry(controller: AbortController): void {
		if (controller.signal.aborted || this.stream !== controller) return
		this.live = false
		this.schedulePoll()
		const delay = RETRY_MS[Math.min(this.failures++, RETRY_MS.length - 1)]
		setTimeout(() => { if (this.stream === controller) void this.connect() }, delay)
	}
}

const watchers = new WeakMap<Caller, Watcher>()
function watcher(caller: Caller): Watcher {
	let w = watchers.get(caller)
	if (!w) watchers.set(caller, w = new Watcher(caller))
	return w
}

/** A task of the server, followed through its hubby's watcher. */
function remoteTask(caller: Caller, initial: TaskState): Task {
	let state = initial
	const w = watcher(caller)
	const local = new Set<(state: TaskState) => void>()
	let unfollow: (() => void) | null = null
	const update = (next: TaskState) => {
		// a late poll never takes a finished task back
		if (isFinished(state) && !isFinished(next)) return
		state = next
		local.forEach(listener => listener(state))
		if (isFinished(state)) { unfollow?.(); unfollow = null }
	}
	const on = (listener: (state: TaskState) => void) => {
		local.add(listener)
		listener(state)
		if (!isFinished(state) && !unfollow) unfollow = w.follow(state.id, update)
		return () => {
			local.delete(listener)
			if (local.size === 0) { unfollow?.(); unfollow = null }
		}
	}
	const finished = () => new Promise<TaskState>(resolve => {
		if (isFinished(state)) { resolve(state); return }
		const stop = on(s => { if (isFinished(s)) { queueMicrotask(() => stop()); resolve(s) } })
	})

	return {
		id: state.id,
		get state() { return state },
		on,
		events: signal => events(on, signal),
		async result<T>() {
			const end = await finished()
			if (end.status === 'cancelled') throw new TaskCancelledError(end.id)
			// the response the call got: an ApiError (its status, its message) when it failed
			return read<T>(await send(caller, `/api/cap/tasks/${end.id}/result`))
		},
		async cancel() {
			const response = await send(caller, `/api/cap/tasks/${state.id}`, { method: 'DELETE' }).catch(async err => {
				// finished meanwhile: what it is
				if (err instanceof Error && err.message === 'HTTP 409') return null
				throw err
			})
			update(response ? (await read<{ data: TaskState }>(response)).data : await w.state(state.id))
			return state
		}
	}
}

/** A call that ran at once (not taskable): a task already finished, its result the call's. */
function settledTask(response: Response, value: unknown): Task {
	const now = new Date().toISOString()
	const state: TaskState = {
		id: `sync-${Math.random().toString(36).slice(2)}`, operation: '', status: 'succeeded', progress: null,
		httpStatus: response.status, error: null, createdAt: now, startedAt: now, finishedAt: now
	}
	const on = (listener: (state: TaskState) => void) => { listener(state); return () => {} }
	return {
		id: state.id,
		state,
		on,
		events: signal => events(on, signal),
		result: async <T>() => value as T,
		cancel: async () => state
	}
}

/** A task's changes as an async iterator, until it is finished. */
async function* events(on: Task['on'], signal?: AbortSignal): AsyncIterableIterator<TaskState> {
	const queue: TaskState[] = []
	let wake: (() => void) | null = null
	const stop = on(state => { queue.push(state); wake?.() })
	const abort = () => wake?.()
	signal?.addEventListener('abort', abort)
	try {
		while (!signal?.aborted) {
			if (queue.length === 0) await new Promise<void>(resolve => { wake = resolve })
			wake = null
			while (queue.length > 0) {
				const state = queue.shift()!
				yield state
				if (isFinished(state)) return
			}
		}
	}
	finally {
		stop()
		signal?.removeEventListener('abort', abort)
	}
}

/** A call answered 202 though made in sync (an operation always run as a task): its result, once there. */
export async function awaitTask<T>(caller: Caller, id: string): Promise<T> {
	const state = await watcher(caller).state(id)
	return remoteTask(caller, state).result<T>()
}

/** The tasks API of a caller (a hubby). */
export function createTasks(caller: Caller): TasksApi {
	return {
		async start(path, options = {}) {
			const headers = new Headers(options.headers)
			headers.set('Prefer', 'respond-async')
			const response = await send(caller, path, { ...options, headers: Object.fromEntries(headers) })
			if (taskOf(response)) return remoteTask(caller, (await read<{ data: TaskState }>(response)).data)
			return settledTask(response, await read(response))
		},
		async get(id) {
			return remoteTask(caller, await watcher(caller).state(id))
		},
		async list(status) {
			const response = await send(caller, `/api/cap/tasks${status ? `?status=${status}` : ''}`)
			return (await read<{ data: TaskState[] }>(response)).data
		}
	}
}
