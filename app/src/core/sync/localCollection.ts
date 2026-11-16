import { ApiError } from '@core/api/client'
import { modelsOf, type ModelFile } from '@core/crypto/documents'
import { uuidv7 } from '@core/crypto/format'
import type { BatchOperation, CollectionPage, CollectionQuery, FilterValue, HubbyDocument } from '@core/hubby/collections'
import { engine, type HubbySync } from './engine'
import { parse } from './hlc'
import type { DocState, FieldValue } from './replica'
import { decode, InvalidDocument } from './validate'

/**
 * A module's collection served by this device's base (docs/plan-local-first.md § 3.7): the same
 * calls as on the server (core/hubby/collections.ts), answered from the replica. Filters, sorts and
 * pages run here, on every field (encrypted ones included: they are in clear on the device); a
 * condition on a list field matches when one of its items does (as Mongo). Documents are checked
 * against the module's models (validate.ts), with their unique indexes (on this device: two
 * devices offline can still both write the same value) and their references (`onDelete`), as the
 * server does.
 */

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

type Doc = Record<string, unknown> & HubbyDocument

const iso = (hlc: string) => new Date(parse(hlc).wall).toISOString()

function toDoc(id: string, data: Record<string, FieldValue>, state: DocState): Doc {
	return { ...data, id, _createdAt: iso(state.created), _updatedAt: iso(state.updated), _version: state.version }
}

function compare(a: unknown, b: unknown): number {
	if (a === b) return 0
	if (a === null || a === undefined) return -1
	if (b === null || b === undefined) return 1
	if (typeof a === 'number' && typeof b === 'number') return a - b
	if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b)
	return String(a) < String(b) ? -1 : 1
}

function matchesValue(value: unknown, condition: FilterValue): boolean {
	if (condition === null || typeof condition !== 'object') return compare(value, condition) === 0
	const c = condition
	if (c.eq !== undefined && compare(value, c.eq) !== 0) return false
	if (c.ne !== undefined && compare(value, c.ne) === 0) return false
	if (c.in !== undefined && !c.in.some(v => compare(value, v) === 0)) return false
	if (c.gt !== undefined && !(value !== null && compare(value, c.gt) > 0)) return false
	if (c.gte !== undefined && !(value !== null && compare(value, c.gte) >= 0)) return false
	if (c.lt !== undefined && !(value !== null && compare(value, c.lt) < 0)) return false
	if (c.lte !== undefined && !(value !== null && compare(value, c.lte) <= 0)) return false
	if (c.exists !== undefined && (value !== null) !== c.exists) return false
	if (c.prefix !== undefined && !(typeof value === 'string' && value.startsWith(c.prefix))) return false
	return true
}

function matches(doc: Doc, filter: Record<string, FilterValue> = {}): boolean {
	for (const [field, condition] of Object.entries(filter)) {
		const value = doc[field] ?? null
		if (Array.isArray(value)) {
			// a list: `ne` when no item is equal; `exists` on the list itself; the rest when one item matches
			if (condition !== null && typeof condition === 'object' && condition.ne !== undefined) {
				if (value.some(v => compare(v, condition.ne) === 0)) return false
				const { ne, ...rest } = condition
				void ne
				if (Object.keys(rest).length && !value.some(v => matchesValue(v, rest))) return false
				continue
			}
			if (condition !== null && typeof condition === 'object' && condition.exists !== undefined) {
				if (!condition.exists) return false
				continue
			}
			if (!value.some(v => matchesValue(v, condition))) return false
			continue
		}
		if (!matchesValue(value, condition)) return false
	}
	return true
}

function sorted(docs: Doc[], sort = '-_updatedAt'): Doc[] {
	const desc = sort.startsWith('-')
	const field = desc ? sort.slice(1) : sort
	// the id breaks ties: the same order on every call (pages)
	return docs.sort((a, b) => (desc ? -1 : 1) * (compare(a[field], b[field]) || compare(a.id, b.id)))
}

export function localCollection<T extends object>(module: string, name: string) {
	type D = T & HubbyDocument
	const sync = (): Promise<HubbySync> => { const e = engine(module); return e.ready.then(() => e) }
	const model = (): ModelFile | undefined => modelsOf(module).get(name)

	const all = (e: HubbySync): Doc[] => e.replica.list(name).map(({ id, data, state }) => toDoc(id, data, state))
	const one = (e: HubbySync, id: string): Doc | null => {
		const data = e.replica.get(name, id)
		return data ? toDoc(id, data, e.replica.state(name, id)!) : null
	}
	const found = (e: HubbySync, id: string): Doc => {
		const doc = one(e, id)
		if (!doc) throw new ApiError(404, 'No such document')
		return doc
	}

	/** Checked against the model (defaults for a new document, required fields): as the server would store it. */
	const complete = (data: Record<string, unknown>, creating: boolean): Record<string, unknown> => {
		const m = model()
		if (!m) return data
		try {
			return decode(m, data, !creating)
		}
		catch (err) {
			if (err instanceof InvalidDocument) throw new ApiError(422, err.message)
			throw err
		}
	}

	/** The model's unique indexes, among the documents on this device. */
	const checkUnique = (e: HubbySync, id: string, fields: Record<string, unknown>): void => {
		const merged = { ...(e.replica.get(name, id) ?? {}), ...fields }
		for (const index of model()?.indexes ?? []) {
			if (!index.unique) continue
			const keys = index.fields.map(([field]) => field)
			if (keys.every(k => merged[k] === null || merged[k] === undefined)) continue
			const taken = e.replica.list(name).some(d => d.id !== id && keys.every(k => compare(d.data[k] ?? null, merged[k] ?? null) === 0))
			if (taken) throw new ApiError(409, `Already used: ${keys.join(', ')}`)
		}
	}

	const write = async (e: HubbySync, id: string, data: Record<string, unknown>): Promise<D> => {
		const { id: _id, _createdAt, _updatedAt, _version, ...fields } = data
		void _id; void _createdAt; void _updatedAt; void _version
		checkUnique(e, id, fields)
		e.replica.put(name, id, fields, model()?.version)
		e.wrote()
		return found(e, id) as D
	}

	/** A deletion, and what the models say it does to the documents pointing at it. */
	const removeWithReferences = async (e: HubbySync, id: string): Promise<void> => {
		for (const [collection, other] of modelsOf(module)) {
			for (const [field, spec] of Object.entries(other.fields)) {
				if (spec.type !== 'ref' || spec.collection !== name) continue
				const pointing = e.replica.list(collection).filter(d => d.data[field] === id)
				if (pointing.length === 0) continue
				if (spec.onDelete === 'restrict') throw new ApiError(409, `Still used by ${collection}`)
				for (const doc of pointing) {
					if (spec.onDelete === 'cascade') e.replica.delete(collection, doc.id)
					else e.replica.put(collection, doc.id, { [field]: null })
				}
			}
		}
		e.replica.delete(name, id)
		e.wrote()
	}

	return {
		/** One page (`limit`: 1–200, default 50). */
		async find(q: CollectionQuery = {}): Promise<CollectionPage<D>> {
			const e = await sync()
			const list = sorted(all(e).filter(d => matches(d, q.filter)), q.sort)
			const start = q.cursor ? Number(q.cursor) || 0 : 0
			const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT))
			const page = list.slice(start, start + limit)
			return { data: page as D[], next: start + limit < list.length ? String(start + limit) : null }
		},
		/** Every document matching. */
		async findAll(q: Omit<CollectionQuery, 'cursor' | 'limit'> = {}): Promise<D[]> {
			const e = await sync()
			return sorted(all(e).filter(d => matches(d, q.filter)), q.sort) as D[]
		},
		async get(id: string): Promise<D> {
			return found(await sync(), id) as D
		},
		async create(data: Partial<T>): Promise<D> {
			return this.createWithId(uuidv7(), data)
		},
		/** A new document under an id chosen by the module (a fixed id: two devices make the same one). */
		async createWithId(id: string, data: Partial<T>): Promise<D> {
			const e = await sync()
			if (one(e, id)) throw new ApiError(409, 'A document already has this id')
			return write(e, id, complete(data as Record<string, unknown>, true))
		},
		/** The given fields; `version`: refused (409) if the document changed since. */
		async update(id: string, data: Partial<T>, version?: number): Promise<D> {
			const e = await sync()
			const current = found(e, id)
			if (version !== undefined && version !== current._version) throw new ApiError(409, 'The document changed since')
			return write(e, id, complete(data as Record<string, unknown>, false))
		},
		/** The whole document (the fields not given are emptied). */
		async replace(id: string, data: T): Promise<D> {
			const e = await sync()
			found(e, id)
			// the fields not given are emptied
			const emptied = Object.fromEntries(Object.keys(model()?.fields ?? {}).map(f => [f, null]))
			return write(e, id, complete({ ...emptied, ...(data as Record<string, unknown>) }, true))
		},
		async remove(id: string): Promise<void> {
			const e = await sync()
			found(e, id)
			await removeWithReferences(e, id)
		},
		/** Several operations, in order. */
		async batch(operations: BatchOperation<T>[]): Promise<Array<D | null>> {
			const out: Array<D | null> = []
			for (const op of operations) {
				if (op.op === 'create') out.push(await this.create(op.data))
				else if (op.op === 'update') out.push(await this.update(op.id, op.data, op.version))
				else {
					await this.remove(op.id)
					out.push(null)
				}
			}
			return out
		},
	}
}
