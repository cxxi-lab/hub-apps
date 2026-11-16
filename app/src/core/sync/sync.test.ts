/**
 * The sync's merge, alone (docs/plan-local-first.md § 6, step 0): devices writing offline and
 * reconnecting, in every order, through a relay that only keeps sealed envelopes.
 * Run: npm run test:sync -w app
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKeys, newDataKey } from '@core/crypto/format'
import { Clock, MAX_DRIFT_MS } from './hlc'
import { Replica, type Operation } from './replica'
import { openOperation, sealOperation, type Envelope } from './envelope'

const MODULE = 'planner'
const key = deriveKeys(newDataKey()).fields

/** A relay as the server would be: sealed envelopes in arrival order, read from a position. */
class Relay {
	readonly log: Envelope[] = []
	push(ops: Operation[]): void {
		for (const op of ops) if (!this.log.some(e => e.id === op.id)) this.log.push(sealOperation(key, MODULE, op))
	}
	since(position: number): { ops: Operation[]; position: number } {
		return { ops: this.log.slice(position).map(e => openOperation(key, e)), position: this.log.length }
	}
}

let ids = 0
const newId = () => `op${++ids}`

function device(name: string, time: { now: number }) {
	const replica = new Replica(new Clock(name, () => time.now), newId)
	let position = 0
	return {
		replica,
		sync(relay: Relay) {
			relay.push(replica.takeOutbox())
			const { ops, position: next } = relay.since(position)
			replica.receive(ops)
			position = next
		},
	}
}

/** a seeded shuffle (the same orders on every run) */
function shuffled<T>(items: T[], seed: number): T[] {
	const out = [...items]
	let s = seed
	for (let i = out.length - 1; i > 0; i--) {
		s = (s * 1103515245 + 12345) % 2 ** 31
		const j = s % (i + 1);
		[out[i], out[j]] = [out[j], out[i]]
	}
	return out
}

test('two devices offline change two fields of one event: both changes are kept', () => {
	const time = { now: 1_000_000 }
	const relay = new Relay()
	const a = device('a', time), b = device('b', time)
	a.replica.put('event', 'e1', { title: 'Dentist', startsAt: '2026-11-20T10:00' })
	a.sync(relay); b.sync(relay)

	time.now += 1000
	a.replica.put('event', 'e1', { title: 'Dentist (Dr. Martin)' })
	time.now += 1000
	b.replica.put('event', 'e1', { startsAt: '2026-11-20T11:00' })
	a.sync(relay); b.sync(relay); a.sync(relay)

	const expected = { title: 'Dentist (Dr. Martin)', startsAt: '2026-11-20T11:00' }
	assert.deepEqual(a.replica.get('event', 'e1'), expected)
	assert.deepEqual(b.replica.get('event', 'e1'), expected)
})

test('the same field changed on two devices: the later write wins, on both', () => {
	const time = { now: 1_000_000 }
	const relay = new Relay()
	const a = device('a', time), b = device('b', time)
	a.replica.put('event', 'e1', { title: 'A' })
	time.now += 10
	b.replica.put('event', 'e1', { title: 'B' })
	b.sync(relay); a.sync(relay); b.sync(relay)
	assert.equal(a.replica.get('event', 'e1')?.title, 'B')
	assert.equal(b.replica.get('event', 'e1')?.title, 'B')
})

test('a wrong system clock does not lose a later write (the clock moves past what it saw)', () => {
	const fast = { now: 1_120_000 }, slow = { now: 1_000_000 } // 2 minutes apart
	const relay = new Relay()
	const a = device('a', fast), b = device('b', slow)
	a.replica.put('event', 'e1', { title: 'from the fast clock' })
	a.sync(relay); b.sync(relay)
	// b's clock is 2 min behind, but it saw a's write: its own comes after
	b.replica.put('event', 'e1', { title: 'written after, on the slow clock' })
	b.sync(relay); a.sync(relay)
	assert.equal(a.replica.get('event', 'e1')?.title, 'written after, on the slow clock')
})

test('a deletion hides what was written before; a write after brings the document back', () => {
	const time = { now: 1_000_000 }
	const relay = new Relay()
	const a = device('a', time), b = device('b', time)
	a.replica.put('event', 'e1', { title: 'Old', notes: 'x' })
	a.sync(relay); b.sync(relay)
	time.now += 10
	b.replica.delete('event', 'e1')
	b.sync(relay); a.sync(relay)
	assert.equal(a.replica.get('event', 'e1'), null)
	assert.deepEqual(a.replica.list('event'), [])

	time.now += 10
	a.replica.put('event', 'e1', { title: 'New' })
	a.sync(relay); b.sync(relay)
	assert.deepEqual(b.replica.get('event', 'e1'), { title: 'New' }, 'the fields from before the deletion stay gone')
})

test('any order, any duplicates: every device ends with the same data', () => {
	const time = { now: 1_000_000 }
	const writers = ['a', 'b', 'c'].map(name => new Replica(new Clock(name, () => time.now), newId))
	const all: Operation[] = []
	for (let i = 0; i < 300; i++) {
		time.now += i % 7 === 0 ? 0 : 3 // some writes in the same millisecond
		const w = writers[i % 3]
		const doc = `e${i % 11}`
		const op = i % 13 === 0 ? w.delete('event', doc) : w.put('event', doc, { [`f${i % 4}`]: `${w.clock.device}${i}` })
		all.push(op)
	}
	const reference = new Replica(new Clock('r', () => time.now), newId)
	reference.receive(all)
	const canonical = (r: Replica) => JSON.stringify(r.list('event')
		.map(({ id, data }) => [id, Object.keys(data).sort().map(k => [k, data[k]])])
		.sort((x, y) => String(x[0]).localeCompare(String(y[0]))))
	const expected = canonical(reference)

	for (let seed = 1; seed <= 20; seed++) {
		const replica = new Replica(new Clock('x', () => time.now), newId)
		const ops = shuffled([...all, ...all.slice(0, 50)], seed)
		replica.receive(ops)
		assert.equal(canonical(replica), expected, `order ${seed}`)
	}
})

test('a new device starts from a snapshot and keeps merging the operations after it', () => {
	const time = { now: 1_000_000 }
	const relay = new Relay()
	const a = device('a', time)
	for (let i = 0; i < 20; i++) a.replica.put('event', `e${i}`, { title: `t${i}` })
	a.sync(relay)
	const snapshot = JSON.parse(JSON.stringify(a.replica.snapshot()))

	time.now += 100
	a.replica.put('event', 'e3', { title: 'changed after the snapshot' })
	a.sync(relay)

	const fresh = Replica.fromSnapshot(snapshot, new Clock('c', () => time.now), newId)
	// the relay replays everything: what the snapshot holds is skipped, the rest applied
	fresh.receive(relay.since(0).ops)
	assert.equal(fresh.list('event').length, 20)
	assert.equal(fresh.get('event', 'e3')?.title, 'changed after the snapshot')
})

test('the relay holds only sealed envelopes; one moved or tampered with does not open', () => {
	const relay = new Relay()
	const a = device('a', { now: 1_000_000 })
	a.replica.put('event', 'e1', { title: 'Secret meeting' })
	a.sync(relay)
	const [envelope] = relay.log
	assert.ok(!envelope.sealed.includes('Secret'), 'nothing readable')
	assert.throws(() => openOperation(key, { ...envelope, module: 'workout' }), /could not be decrypted/)
	assert.throws(() => openOperation(key, { ...envelope, id: 'another' }), /could not be decrypted/)
})

test('an operation from a clock far in the future is applied, without dragging the clock along', () => {
	const time = { now: 1_000_000 }
	const a = new Replica(new Clock('a', () => time.now), newId)
	const broken = new Replica(new Clock('z', () => time.now + MAX_DRIFT_MS + 3_600_000), newId)
	const op = broken.put('event', 'e1', { title: 'from the future' })

	assert.deepEqual(a.receive([op]), [op], 'reported')
	assert.equal(a.get('event', 'e1')?.title, 'from the future', 'applied all the same')
	assert.ok(a.clock.tick() < op.hlc, "this device's clock stayed on its own time")
})

test('an import keeps the documents\' dates, and a later change still wins', () => {
	const time = { now: 1_800_000_000_000 }
	const relay = new Relay()
	const a = device('a', time)
	const b = device('b', time)
	a.replica.putAt('event', 'e1', { title: 'old' }, time.now - 2 * 86_400_000, time.now - 86_400_000)
	a.replica.putAt('event', 'e2', { title: 'future?' }, time.now + 1000, time.now + 1000)
	a.sync(relay)
	b.sync(relay)
	const e1 = b.replica.state('event', 'e1')!
	assert.equal(parseInt(e1.created.slice(0, 9), 36), time.now - 2 * 86_400_000)
	assert.equal(parseInt(e1.updated.slice(0, 9), 36), time.now - 86_400_000)
	assert.equal(parseInt(b.replica.state('event', 'e2')!.created.slice(0, 9), 36), time.now)
	time.now += 1
	b.replica.put('event', 'e1', { title: 'new' })
	b.sync(relay)
	a.sync(relay)
	assert.deepEqual(a.replica.get('event', 'e1'), { title: 'new' })
})
