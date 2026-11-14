import { api, ApiError } from '@core/api/client'
import { currentDataKeys, requireDataKeys, whenDataKeyReady } from '@core/crypto/dataKey'
import { DataKeyMissingError, encryptedModel, encryptedModels, equalityIndex, onModelsRegistered, needsSealing, openDocument, openedUnderFormerId, sealDocument, type EncryptedModel } from '@core/crypto/documents'
import { uuidv7 } from '@core/crypto/format'
import { getApiBaseUrl } from '@core/api/baseUrl'

/**
 * A module's declared collection, through the hubbies' generic API (/api/data/{module}/{collection},
 * docs/spec-module.md § 5): the current account's documents only, checked against the module's
 * model by the server. For the modules running in the app; an isolated hubby gets the same through
 * its host (@cxxi-lab/hub-sdk/frame, packages/hub-sdk/frame/sdk.ts).
 *
 * The fields its model declares encrypted are sealed here, on the device, before they leave, and
 * opened when they come back (core/crypto, docs/plan-storage-encryption.md § 3): the server only
 * ever holds them sealed. A filter on an "equality" one is sent as its blind index.
 */

/** What the platform adds to every document. */
export interface HubbyDocument {
	id: string
	_createdAt: string
	_updatedAt: string
	_version: number
}

/** A filter's value: equality, or operators (`in` takes a list). Fields: indexed ones only. */
export type FilterValue = string | number | boolean | null
	| { eq?: FilterValue, ne?: FilterValue, in?: FilterValue[], gt?: FilterValue, gte?: FilterValue, lt?: FilterValue, lte?: FilterValue, exists?: boolean, prefix?: string }

export interface CollectionQuery {
	filter?: Record<string, FilterValue>
	/** fields along an index, `-` for descending (e.g. '-_updatedAt'); default '-_updatedAt' */
	sort?: string
	/** 1–200, default 50 */
	limit?: number
	cursor?: string
}

export interface CollectionPage<T> {
	data: T[]
	next: string | null
}

export type BatchOperation<T> =
	| { op: 'create', data: Partial<T> }
	| { op: 'update', id: string, data: Partial<T>, version?: number }
	| { op: 'delete', id: string }

function queryString(query: CollectionQuery): string {
	const params = new URLSearchParams()
	const value = (v: FilterValue): string => v === null ? 'null' : String(v)
	for (const [field, filter] of Object.entries(query.filter ?? {})) {
		if (filter !== null && typeof filter === 'object') {
			for (const [op, operand] of Object.entries(filter)) {
				if (operand === undefined) continue
				params.set(`filter[${field}][${op}]`, Array.isArray(operand) ? operand.map(value).join(',') : value(operand as FilterValue))
			}
		}
		else params.set(`filter[${field}]`, value(filter))
	}
	if (query.sort) params.set('sort', query.sort)
	if (query.limit) params.set('limit', String(query.limit))
	if (query.cursor) params.set('cursor', query.cursor)
	const qs = params.toString()
	return qs ? `?${qs}` : ''
}

/** A query's filters on encrypted "equality" fields, as their blind indexes. */
async function blindQuery(model: EncryptedModel, query: CollectionQuery): Promise<CollectionQuery> {
	const fields = Object.keys(query.filter ?? {}).filter(f => model.equality.includes(f))
	if (fields.length === 0) return query
	const keys = await requireDataKeys()
	const filter = { ...query.filter }
	for (const field of fields) {
		const at = (v: FilterValue): FilterValue => typeof v === 'string' ? equalityIndex(keys, model, field, v) : v
		const value = filter[field]
		if (value !== null && typeof value === 'object') {
			filter[field] = { ...value, ...(value.eq !== undefined ? { eq: at(value.eq) } : {}), ...(value.ne !== undefined ? { ne: at(value.ne) } : {}), ...(value.in ? { in: value.in.map(at) } : {}) }
		}
		else filter[field] = at(value)
	}
	return { ...query, filter }
}

/** One of a module's collections. `T`: its declared fields (the platform's are added). */
export function collection<T extends object>(module: string, name: string) {
	type Doc = T & HubbyDocument
	const base = `/api/data/${module}/${name}`
	const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) })
	const model = encryptedModel(module, name)

	// what goes out (sealed), what comes back (opened): nothing to do without encrypted fields
	const outgoing = async (id: string, data: object): Promise<Record<string, unknown>> =>
		model ? sealDocument(await requireDataKeys(), model, id, data as Record<string, unknown>) : { ...data }
	const incoming = async (doc: Doc): Promise<Doc> => {
		if (!model) return doc
		let opened: Doc
		try {
			opened = openDocument(currentDataKeys(), model, doc)
		}
		catch (err) {
			// sealed values and the key not loaded yet (or this device not linked)
			if (!(err instanceof DataKeyMissingError)) throw err
			opened = openDocument(await requireDataKeys(), model, doc)
		}
		// still in clear (imported by the server, or a field that became encrypted): sealed now,
		// in the background, by this device that holds the key
		// sealed under the module's former id (renamed): sealed again under its id
		if ((needsSealing(model, doc as Record<string, unknown>) || openedUnderFormerId(opened)) && currentDataKeys()) sealLater(opened)
		return opened
	}
	const sealLater = (doc: Doc) => {
		const fields = Object.fromEntries(model!.encrypted.filter(f => f in doc).map(f => [f, (doc as Record<string, unknown>)[f]]))
		void outgoing(doc.id, fields)
			.then(sealed => api(`${base}/${doc.id}`, { ...json('PATCH', sealed), headers: { 'If-Match': String(doc._version) } }))
			.catch(err => console.warn(`[crypto] ${module}/${name} ${doc.id}: not sealed yet`, err))
	}
	const incomingAll = (docs: Doc[]) => Promise.all(docs.map(incoming))
	const query = (q: CollectionQuery) => model ? blindQuery(model, q) : Promise.resolve(q)

	return {
		/** One page. */
		async find(q: CollectionQuery = {}): Promise<CollectionPage<Doc>> {
			const page = await api<CollectionPage<Doc>>(`${base}${queryString(await query(q))}`)
			return { ...page, data: await incomingAll(page.data) }
		},
		/** Every document matching, page after page (200 at a time). */
		async findAll(q: Omit<CollectionQuery, 'cursor' | 'limit'> = {}): Promise<Doc[]> {
			const sent = await query(q)
			const all: Doc[] = []
			let cursor: string | undefined
			do {
				const page = await api<CollectionPage<Doc>>(`${base}${queryString({ ...sent, limit: 200, cursor })}`)
				all.push(...page.data)
				cursor = page.next ?? undefined
			} while (cursor)
			return incomingAll(all)
		},
		get: (id: string) => api<{ data: Doc }>(`${base}/${id}`).then(r => incoming(r.data)),
		async create(data: Partial<T>): Promise<Doc> {
			// the id first: the sealed values are bound to it
			const id = uuidv7()
			return incoming((await api<{ data: Doc }>(base, json('POST', { ...(await outgoing(id, data)), id }))).data)
		},
		/** The given fields; `version`: refused (409) if the document changed since. */
		async update(id: string, data: Partial<T>, version?: number): Promise<Doc> {
			return incoming((await api<{ data: Doc }>(`${base}/${id}`, {
				...json('PATCH', await outgoing(id, data)),
				headers: version === undefined ? undefined : { 'If-Match': String(version) }
			})).data)
		},
		/** The whole document (the fields not given are emptied). */
		async replace(id: string, data: T): Promise<Doc> {
			return incoming((await api<{ data: Doc }>(`${base}/${id}`, json('PUT', await outgoing(id, data)))).data)
		},
		remove: (id: string) => api<void>(`${base}/${id}`, { method: 'DELETE' }),
		/** Up to 100 operations, all or nothing. */
		async batch(operations: BatchOperation<T>[]): Promise<Array<Doc | null>> {
			const sent = await Promise.all(operations.map(async op => {
				if (op.op === 'create') {
					const id = uuidv7()
					return { op: 'create', data: { ...(await outgoing(id, op.data)), id } }
				}
				if (op.op === 'update') return { ...op, data: await outgoing(op.id, op.data) }
				return op
			}))
			const results = (await api<{ data: Array<Doc | null> }>(`${base}/_batch`, json('POST', { operations: sent }))).data
			return Promise.all(results.map(doc => doc ? incoming(doc) : null))
		}
	}
}

// --- sealing what is still in clear (documents imported by the server, fields newly encrypted) ---

const SEALED_KEY = 'hub.sealed'

/**
 * Every collection with encrypted fields, once per model version and server: the documents still
 * holding some of them in clear get them sealed (written again by this device, which holds the key).
 */
export async function sealLeftInClear(): Promise<void> {
	const marks: Record<string, number> = JSON.parse(localStorage.getItem(SEALED_KEY) ?? '{}')
	const server = getApiBaseUrl('/api/m')
	for (const model of encryptedModels()) {
		const mark = `${server}|${model.module}/${model.collection}`
		if (marks[mark] === model.version) continue
		try {
			const docs = await collection<Record<string, unknown>>(model.module, model.collection).findAll()
			let sealed = 0
			for (const doc of docs) {
				if (!needsSealing(model, doc)) continue
				const data = Object.fromEntries(model.encrypted.filter(f => f in doc).map(f => [f, doc[f]]))
				await collection(model.module, model.collection).update(doc.id, data, doc._version)
				sealed++
			}
			if (sealed) console.log(`[crypto] ${model.module}/${model.collection}: ${sealed} document(s) sealed`)
			marks[mark] = model.version
		}
		catch (err) {
			// a module this account doesn't have: nothing to seal there
			if (err instanceof ApiError && (err.status === 403 || err.status === 404)) marks[mark] = model.version
			else console.warn(`[crypto] ${model.module}/${model.collection}: not sealed yet`, err)
		}
	}
	localStorage.setItem(SEALED_KEY, JSON.stringify(marks))
}

let sealing: Promise<void> | null = null
const sealAll = () => {
	sealing ??= sealLeftInClear().finally(() => { sealing = null })
}
whenDataKeyReady(sealAll)
// a module loaded later (installed meanwhile): its collections too, once the key is here
onModelsRegistered(() => { if (currentDataKeys()) sealAll() })
