import { ApiError } from '@core/api/client'
import { modelsOf, type ModelFile } from '@core/crypto/documents'
import { uuidv7 } from '@core/crypto/format'
import type { BatchOperation, CollectionPage, CollectionQuery, FilterValue, HubbyDocument } from '@core/hubby/collections'
import { engine, mirror, type ModuleSync } from './engine'
import { parse } from './hlc'
import type { DocState, FieldValue } from './replica'

/**
 * A module's collection served by this device's base (docs/plan-local-first.md § 3.7): the same
 * calls as on the server (core/hubby/collections.ts), answered from the replica. Filters, sorts and
 * pages run here, on every field (encrypted ones included: they are in clear on the device).
 * Defaults, required fields and references (`onDelete`) follow the module's models, as the server
 * does.
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

function matches(doc: Doc, filter: Record<string, FilterValue> = {}): boolean {
	for (const [field, condition] of Object.entries(filter)) {
		const value = doc[field] ?? null
		if (condition === null || typeof condition !== 'object') {
			if (compare(value, condition) !== 0) return false
			continue
		}
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
	const sync = (): Promise<ModuleSync> => { const e = engine(module); return e.ready.then(() => e) }
	const model = (): ModelFile | undefined => modelsOf(module).get(name)

	const all = (e: ModuleSync): Doc[] => e.replica.list(name).map(({ id, data, state }) => toDoc(id, data, state))
	const one = (e: ModuleSync, id: string): Doc | null => {
		const data = e.replica.get(name, id)
		return data ? toDoc(id, data, e.replica.state(name, id)!) : null
	}
	const found = (e: ModuleSync, id: string): Doc => {
		const doc = one(e, id)
		if (!doc) throw new ApiError(404, 'No such document')
		return doc
	}

	/** Defaults for the fields not given (a new document), then the required ones checked. */
	const complete = (data: Record<string, unknown>, creating: boolean): Record<string, unknown> => {
		const fields = model()?.fields ?? {}
		const out = { ...data }
		if (creating) {
			for (const [field, spec] of Object.entries(fields)) {
				if (out[field] === undefined && spec.default !== undefined) out[field] = spec.default
			}
		}
		for (const [field, spec] of Object.entries(fields)) {
			if (spec.required && (creating || field in out) && (out[field] === undefined || out[field] === null || out[field] === '')) {
				throw new ApiError(422, `${field} is required`)
			}
		}
		return out
	}

	const write = async (e: ModuleSync, id: string, data: Record<string, unknown>, existed: boolean): Promise<D> => {
		const { id: _id, _createdAt, _updatedAt, _version, ...fields } = data
		void _id; void _createdAt; void _updatedAt; void _version
		const op = e.replica.put(name, id, fields, model()?.version)
		e.wrote()
		void mirror(module, op, existed)
		return found(e, id) as D
	}

	/** A deletion, and what the models say it does to the documents pointing at it. */
	const removeWithReferences = async (e: ModuleSync, id: string): Promise<void> => {
		for (const [collection, other] of modelsOf(module)) {
			for (const [field, spec] of Object.entries(other.fields)) {
				if (spec.type !== 'ref' || spec.collection !== name) continue
				const pointing = e.replica.list(collection).filter(d => d.data[field] === id)
				if (pointing.length === 0) continue
				if (spec.onDelete === 'restrict') throw new ApiError(409, `Still used by ${collection}`)
				for (const doc of pointing) {
					const op = spec.onDelete === 'cascade' ? e.replica.delete(collection, doc.id) : e.replica.put(collection, doc.id, { [field]: null })
					void mirror(module, op, true)
				}
			}
		}
		const op = e.replica.delete(name, id)
		e.wrote()
		void mirror(module, op, true)
	}

	return {
		async find(q: CollectionQuery = {}): Promise<CollectionPage<D>> {
			const e = await sync()
			const list = sorted(all(e).filter(d => matches(d, q.filter)), q.sort)
			const start = q.cursor ? Number(q.cursor) || 0 : 0
			const limit = Math.min(MAX_LIMIT, Math.max(1, q.limit ?? DEFAULT_LIMIT))
			const page = list.slice(start, start + limit)
			return { data: page as D[], next: start + limit < list.length ? String(start + limit) : null }
		},
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
		async createWithId(id: string, data: Partial<T>): Promise<D> {
			const e = await sync()
			if (one(e, id)) throw new ApiError(409, 'A document already has this id')
			return write(e, id, complete(data as Record<string, unknown>, true), false)
		},
		async update(id: string, data: Partial<T>, version?: number): Promise<D> {
			const e = await sync()
			const current = found(e, id)
			if (version !== undefined && version !== current._version) throw new ApiError(409, 'The document changed since')
			return write(e, id, complete(data as Record<string, unknown>, false), true)
		},
		async replace(id: string, data: T): Promise<D> {
			const e = await sync()
			found(e, id)
			// the fields not given are emptied
			const emptied = Object.fromEntries(Object.keys(model()?.fields ?? {}).map(f => [f, null]))
			return write(e, id, complete({ ...emptied, ...(data as Record<string, unknown>) }, true), true)
		},
		async remove(id: string): Promise<void> {
			const e = await sync()
			found(e, id)
			await removeWithReferences(e, id)
		},
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
