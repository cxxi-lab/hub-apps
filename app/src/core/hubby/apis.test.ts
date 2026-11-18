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
		'timeline.items': ({ start }) => [{ title: `Run from ${start}` }],
		'sessions.broken': () => ({ not: 'an array' })
	})
	assert.deepEqual(await callHubby('planner', 'workout', 'timeline.items', { start: '2026-11-18' }), [{ title: 'Run from 2026-11-18' }])
	await assert.rejects(callHubby('planner', 'workout', 'timeline.items', {}), /invalid input for workout timeline.items: \$.start: required/)
	await assert.rejects(callHubby('planner', 'workout', 'sessions.broken', {}), /gave an invalid result: \$: expected array/)
	await assert.rejects(callHubby('planner', 'workout', 'toString', {}), /offers no method toString/)
	await assert.rejects(callHubby('planner', 'budget', 'items', {}), /budget is not available/)
	stop()
})

test('an interface: every hubby offering it, each answer or failure', async () => {
	setAvailableHubbies(['workout', 'budget'])
	const stops = [
		frame('workout', { 'timeline.items': () => [{ title: 'Run' }] }),
		frame('budget', { 'items': () => { throw new Error('no bills here') } })
	]
	assert.deepEqual(await callAll('planner', 'timeline.items', { start: '2026-11-18' }), [
		{ hubby: 'workout', result: [{ title: 'Run' }] },
		{ hubby: 'budget', error: 'no bills here' }
	])
	// a hubby locked or hidden meanwhile: no longer asked
	setAvailableHubbies(['budget'])
	assert.deepEqual((await callAll('planner', 'timeline.items', { start: 'x' })).map(a => a.hubby), ['budget'])
	stops.forEach(stop => stop())
})
