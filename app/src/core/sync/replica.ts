import { Clock } from './hlc'

/**
 * A module's data as one device holds it, merged from the operations of every device
 * (docs/plan-local-first.md § 3.2–3.5). The merge is the same whatever the order the operations
 * arrive in, and an operation applied twice changes nothing:
 *  - each field keeps the value of its latest write (by timestamp), so two devices changing two
 *    fields of a document keep both changes;
 *  - a deletion hides the fields written before it; a write after it brings the document back with
 *    the fields written since.
 *
 * Pure data: no storage, no network. The base (SQLite) and the relay wrap it.
 */

export type FieldValue = unknown

export interface Operation {
	/** unique (a uuidv7, or anything unique): applying it twice changes nothing */
	id: string
	/** its timestamp (hlc.ts) */
	hlc: string
	collection: string
	doc: string
	/** `put`: fields written (the others kept); `delete`: the document deleted */
	kind: 'put' | 'delete'
	fields?: Record<string, FieldValue>
	/** the module's model version it was written with */
	modelVersion?: number
}

export interface FieldState { value: FieldValue; hlc: string }
/** A document as merged: each field with its latest write, its last deletion, and when it was first and last written. */
export interface DocState {
	fields: Record<string, FieldState>
	deleted: string | null
	created: string
	updated: string
	/** changes applied here (this device's count: what If-Match compares) */
	version: number
}

/** What a replica is, to start another from it (a new device). */
export interface Snapshot {
	clock: string
	docs: Record<string, Record<string, DocState>>
}

export class Replica {
	private readonly docs = new Map<string, Map<string, DocState>>()
	/** written here, not sent yet */
	private outbox: Operation[] = []
	private readonly listeners = new Set<(collection: string, doc: string) => void>()

	constructor(readonly clock: Clock, private readonly newId: () => string) {}

	static fromSnapshot(snapshot: Snapshot, clock: Clock, newId: () => string): Replica {
		const replica = new Replica(clock, newId)
		clock.receive(snapshot.clock)
		for (const [collection, docs] of Object.entries(snapshot.docs)) {
			replica.docs.set(collection, new Map(Object.entries(docs).map(([id, state]) => [id, structuredClone(state)])))
		}
		return replica
	}

	// --- writing here ---

	put(collection: string, doc: string, fields: Record<string, FieldValue>, modelVersion?: number): Operation {
		return this.local({ id: this.newId(), hlc: this.clock.tick(), collection, doc, kind: 'put', fields, modelVersion })
	}

	delete(collection: string, doc: string): Operation {
		return this.local({ id: this.newId(), hlc: this.clock.tick(), collection, doc, kind: 'delete' })
	}

	/** The operations to send, taken (sent again by the caller if sending fails). */
	takeOutbox(): Operation[] {
		const out = this.outbox
		this.outbox = []
		return out
	}

	/** Operations that couldn't be sent, back in front of the next ones. */
	requeue(operations: Operation[]): void {
		this.outbox = [...operations, ...this.outbox]
	}

	// --- receiving ---

	/**
	 * Operations from the relay (any device, any order, some maybe already applied: applying one
	 * again changes nothing). Returns those stamped too far in the future (applied all the same):
	 * a device's clock is wrong.
	 */
	receive(operations: Operation[]): Operation[] {
		const drifted: Operation[] = []
		for (const op of operations) {
			if (!this.clock.receive(op.hlc)) drifted.push(op)
			this.apply(op)
		}
		return drifted
	}

	/** Documents as stored (a base read back at start): no operation, no listener called. */
	load(collection: string, docs: Record<string, DocState>): void {
		let map = this.docs.get(collection)
		if (!map) this.docs.set(collection, map = new Map())
		for (const [id, state] of Object.entries(docs)) map.set(id, state)
	}

	/** A document as merged, to store it. */
	state(collection: string, doc: string): DocState | null {
		return this.docs.get(collection)?.get(doc) ?? null
	}

	/** The outbox as it stands (to store it, without taking it). */
	pending(): Operation[] {
		return [...this.outbox]
	}

	// --- reading ---

	get(collection: string, doc: string): Record<string, FieldValue> | null {
		const state = this.docs.get(collection)?.get(doc)
		return state ? materialize(state) : null
	}

	list(collection: string): Array<{ id: string; data: Record<string, FieldValue>; state: DocState }> {
		const out: Array<{ id: string; data: Record<string, FieldValue>; state: DocState }> = []
		for (const [id, state] of this.docs.get(collection) ?? []) {
			const data = materialize(state)
			if (data) out.push({ id, data, state })
		}
		return out
	}

	/** Called on each document that changes (written here or received). */
	subscribe(listener: (collection: string, doc: string) => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	snapshot(): Snapshot {
		const docs: Snapshot['docs'] = {}
		for (const [collection, map] of this.docs) docs[collection] = Object.fromEntries([...map].map(([id, s]) => [id, structuredClone(s)]))
		return { clock: this.clock.current(), docs }
	}

	// ---

	private local(op: Operation): Operation {
		this.apply(op)
		this.outbox.push(op)
		return op
	}

	private apply(op: Operation): void {
		let collection = this.docs.get(op.collection)
		if (!collection) this.docs.set(op.collection, collection = new Map())
		let state = collection.get(op.doc)
		if (!state) collection.set(op.doc, state = { fields: {}, deleted: null, created: op.hlc, updated: op.hlc, version: 0 })

		let changed = false
		if (op.kind === 'delete') {
			if (state.deleted === null || op.hlc > state.deleted) {
				state.deleted = op.hlc
				changed = true
			}
		}
		else {
			for (const [field, value] of Object.entries(op.fields ?? {})) {
				const current = state.fields[field]
				if (!current || op.hlc > current.hlc) {
					state.fields[field] = { value, hlc: op.hlc }
					changed = true
				}
			}
		}
		if (op.hlc < state.created) state.created = op.hlc
		if (op.hlc > state.updated) state.updated = op.hlc
		if (!changed) return
		state.version++
		this.listeners.forEach(listener => listener(op.collection, op.doc))
	}
}

/** A document as it reads: its fields written after its last deletion; null when none. */
function materialize(state: DocState): Record<string, FieldValue> | null {
	const out: Record<string, FieldValue> = {}
	let any = false
	for (const [field, { value, hlc }] of Object.entries(state.fields)) {
		if (state.deleted !== null && hlc < state.deleted) continue
		out[field] = value
		any = true
	}
	return any ? out : null
}
