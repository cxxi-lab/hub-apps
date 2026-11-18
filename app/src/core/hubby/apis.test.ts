import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate } from './schema'
import { callAll, callHubby, registerApi, served, serveFrom, setAvailableHubbies } from './apis'

test('the schemas: types, required, extra properties, items, bounds', () => {
	const schema = {
		type: 'object',
		required: ['start'],
		additionalProperties: false,
		properties: { start: { type: 'string', pattern: '^\\d{4}-' }, limit: { type: 'integer', minimum: 1, maximum: 50 }, tags: { type: 'array', items: { type: 'string' }, maxItems: 2 } }
	}
	assert.equal(validate(schema, { start: '2026-11-01', limit: 3, tags: ['a'] }), null)
	assert.equal(validate(schema, {}), '$.start: required')
	assert.equal(validate(schema, { start: '2026-', other: 1 }), '$.other: not allowed')
	assert.equal(validate(schema, { start: 'nov' }), '$.start: does not match its pattern')
	assert.equal(validate(schema, { start: '2026-', limit: 1.5 }), '$.limit: expected integer, got number')
	assert.equal(validate(schema, { start: '2026-', limit: 99 }), '$.limit: above 50')
	assert.equal(validate(schema, { start: '2026-', tags: ['a', 2] }), '$.tags[1]: expected string, got number')
	assert.equal(validate({ anyOf: [{ type: 'null' }, { type: 'string' }] }, 3), '$: fits none of its forms')
	assert.equal(validate({ enum: ['read', 'write'] }, 'write'), null)
})

const open = { type: 'object' }
registerApi('workout', { methods: {
	'timeline.items': { description: 'Its sessions', input: { type: 'object', required: ['start'], properties: { start: { type: 'string' } } }, output: { type: 'array', items: { type: 'object', required: ['title'] } }, effect: 'read', interface: 'timeline.items' },
	'sessions.broken': { description: 'Gives a wrong result', input: open, output: { type: 'array' }, effect: 'read' }
} })
registerApi('budget', { methods: { 'items': { description: 'Its bills', input: open, output: { type: 'array' }, effect: 'read', interface: 'timeline.items' } } })

// a frame answering as the hubby's code would (its `api` in defineHubby)
function frame(hubby: string, handlers: Record<string, (input: any) => unknown>) {
	return serveFrom(hubby, {
		headless: false,
		serve: (id, method, input) => {
			queueMicrotask(async () => {
				try { served(id, true, await handlers[method](input)) }
				catch (err) { served(id, false, undefined, (err as Error).message) }
			})
		}
	})
}

test('a named hubby: checked in and out, answered by its frame', async () => {
	setAvailableHubbies(['workout'])
	const stop = frame('workout', {
		'timeline.items': ({ start }) => [{ id: 's1', date: start, title: 'Run', href: '/history?session=s1' }],
		'sessions.broken': () => ({ not: 'an array' })
	})
	assert.deepEqual(await callHubby('planner', 'workout', 'timeline.items', { start: '2026-11-18T00:00:00Z' }), [{ id: 's1', date: '2026-11-18T00:00:00Z', title: 'Run', href: '/history?session=s1' }])
	await assert.rejects(callHubby('planner', 'workout', 'timeline.items', {}), /invalid input for workout timeline.items: \$.start: required/)
	await assert.rejects(callHubby('planner', 'workout', 'sessions.broken', {}), /gave an invalid result: \$: expected array/)
	await assert.rejects(callHubby('planner', 'workout', 'toString', {}), /offers no method toString/)
	await assert.rejects(callHubby('planner', 'budget', 'items', {}), /budget is not available/)
	stop()
})

test('an interface: every hubby offering it, each answer or failure, its contract checked', async () => {
	setAvailableHubbies(['workout', 'budget'])
	const range = { start: '2026-11-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z' }
	const run = { id: 's1', date: '2026-11-18T07:00:00.000Z', title: 'Run', href: '/history?session=s1', color: '#059669' }
	let budget: () => unknown = () => { throw new Error('no bills here') }
	const stops = [
		frame('workout', { 'timeline.items': () => [run] }),
		frame('budget', { 'items': () => budget() })
	]
	assert.deepEqual(await callAll('planner', 'timeline.items', range), [
		{ hubby: 'workout', result: [run] },
		{ hubby: 'budget', error: 'no bills here' }
	])
	// the interface's contract, whatever the hubby's own api.json says
	await assert.rejects(callAll('planner', 'timeline.items', { start: 'today' }), /invalid input for timeline.items: \$.end: required/)
	budget = () => [{ id: 'b1', date: '2026-11-20', title: 'Rent', href: 'rent' }]
	assert.match((await callAll('planner', 'timeline.items', range))[1].error ?? '', /budget gave an invalid timeline.items: \$\[0\].date: does not match its pattern/)
	// a hubby locked or hidden meanwhile: no longer asked
	setAvailableHubbies(['workout'])
	assert.deepEqual((await callAll('planner', 'timeline.items', range)).map(a => a.hubby), ['workout'])
	stops.forEach(stop => stop())
})
