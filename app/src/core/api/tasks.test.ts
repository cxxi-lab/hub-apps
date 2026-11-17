/**
 * The tasks of the SDK (server docs/plan-tasks.md), against a fake server: a call started as a
 * task, followed by a hook and a stream, its result read; a sync call answered 202 awaited unseen;
 * a cancelled task; an operation that isn't taskable. Without a Mercure hub: the tasks are polled.
 * Run: npm run test:tasks -w app
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError, request, type Caller } from './client'
import { createTasks, TaskCancelledError, timing, type TaskState } from './tasks'

timing.poll = 20

const caller: Caller = {
	headers: async () => ({ Authorization: 'Bearer hubby' }),
	unauthorized: async () => false,
	locked: () => {}
}

interface Fake { state: TaskState, result: { status: number, body: unknown }, polls: number, runsAfter: number }

/** The server: one taskable operation (POST /op), `/plain` not taskable, the tasks' routes. */
function server(behaviour: { result?: { status: number, body: unknown }, runsAfter?: number, always?: boolean } = {}) {
	const tasks = new Map<string, Fake>()
	let next = 0
	const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
		new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

	globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
		const url = new URL(String(input))
		const path = url.pathname
		const method = init.method ?? 'GET'
		const prefer = new Headers(init.headers).get('Prefer') === 'respond-async'
		if (path === '/plain') return json(200, { plain: true })
		if (path === '/op' && (prefer || behaviour.always)) {
			const id = (++next).toString(16).padStart(24, '0')
			const state: TaskState = { id, operation: 'POST /op', status: 'queued', progress: null, httpStatus: null, error: null, createdAt: '', startedAt: null, finishedAt: null }
			tasks.set(id, { state, result: behaviour.result ?? { status: 200, body: { done: init.body } }, polls: 0, runsAfter: behaviour.runsAfter ?? 2 })
			return json(202, { data: state }, { Location: `/api/cap/tasks/${id}` })
		}
		if (path === '/op') return json(200, { done: init.body, sync: true })
		if (path === '/api/cap/tasks/live') return json(200, { data: null })
		if (path === '/api/cap/tasks') return json(200, { data: [...tasks.values()].map(t => t.state) })
		const m = path.match(/^\/api\/cap\/tasks\/([0-9a-f]{24})(\/result)?$/)
		const task = m ? tasks.get(m[1]) : undefined
		if (!task) return json(404, { error: 'not found' })
		const finished = ['succeeded', 'failed', 'cancelled'].includes(task.state.status)
		if (method === 'DELETE') {
			if (finished) return json(409, { error: 'the task is finished' })
			task.state = { ...task.state, status: 'cancelled' }
			return json(200, { data: task.state })
		}
		if (m![2]) {
			if (task.state.status === 'cancelled') return json(410, { error: 'the task was cancelled' })
			return finished ? json(task.result.status, task.result.body) : json(409, { error: 'the task is not finished' })
		}
		// each poll moves it on: queued → running (progress) → finished
		if (!finished) {
			task.polls++
			if (task.polls >= task.runsAfter) {
				const ok = task.result.status < 300
				task.state = { ...task.state, status: ok ? 'succeeded' : 'failed', httpStatus: task.result.status, error: ok ? null : 'refused', progress: { done: 2, total: 2, message: null } }
			}
			else task.state = { ...task.state, status: 'running', progress: { done: 1, total: 2, message: 'half' } }
		}
		return json(200, { data: task.state })
	}) as typeof fetch
	return tasks
}

test('started as a task: followed by a hook, then its result', async () => {
	server()
	const tasks = createTasks(caller)
	const task = await tasks.start('/op', { method: 'POST', body: 'x' })
	assert.equal(task.state.status, 'queued')
	const seen: string[] = []
	const stop = task.on(state => seen.push(state.status))
	assert.deepEqual(await task.result(), { done: 'x' })
	stop()
	assert.equal(seen[0], 'queued')
	assert.equal(seen.at(-1), 'succeeded')
	assert.ok(seen.includes('running'))
	assert.equal((await tasks.list()).length, 1)
})

test('followed by a stream, which ends with the task', async () => {
	server({ runsAfter: 3 })
	const task = await createTasks(caller).start('/op', { method: 'POST', body: 'y' })
	const states: TaskState[] = []
	for await (const state of task.events()) states.push(state)
	assert.equal(states.at(-1)?.status, 'succeeded')
	assert.deepEqual(states.find(s => s.status === 'running')?.progress, { done: 1, total: 2, message: 'half' })
})

test('a failed call: its result throws the call\'s own error', async () => {
	server({ result: { status: 422, body: { error: 'not that one' } } })
	const task = await createTasks(caller).start('/op', { method: 'POST' })
	await assert.rejects(task.result(), (err: unknown) => err instanceof ApiError && err.status === 422 && err.detail === 'not that one')
	assert.equal(task.state.status, 'failed')
})

test('cancelled: its result throws TaskCancelledError', async () => {
	server({ runsAfter: 100 })
	const task = await createTasks(caller).start('/op', { method: 'POST' })
	assert.equal((await task.cancel()).status, 'cancelled')
	await assert.rejects(task.result(), TaskCancelledError)
	// cancelled again: finished, what it is
	assert.equal((await task.cancel()).status, 'cancelled')
})

test('not taskable: run at once, a task already finished', async () => {
	server()
	const task = await createTasks(caller).start('/plain', { method: 'POST' })
	assert.equal(task.state.status, 'succeeded')
	assert.deepEqual(await task.result(), { plain: true })
	const states: TaskState[] = []
	for await (const state of task.events()) states.push(state)
	assert.equal(states.length, 1)
})

test('in sync: a 202 is awaited unseen, the call resolving with the task\'s result', async () => {
	server({ always: true })
	assert.deepEqual(await request(caller, '/op', { method: 'POST', body: 'z' }), { done: 'z' })
	// and a sync call to a taskable operation, not always one: at once
	server()
	assert.deepEqual(await request(caller, '/op', { method: 'POST', body: 'w' }), { done: 'w', sync: true })
})
