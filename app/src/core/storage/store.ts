import { useEffect, useSyncExternalStore } from 'react'
import { api, apiUpload } from '@core/api/client'
import { getApiBaseUrl } from '@core/api/baseUrl'
import { getAuthData } from '@core/auth/authState'
import { MODULE_MANIFESTS } from '@core/module/registry'
import type { StorageScope } from '@core/module/types'
import { platform, type StoredDocument, type StoredFile } from '@platform'
import { requireDataKeys } from '@core/crypto/dataKey'
import { isSealed, open, seal } from '@core/crypto/format'

/**
 * The modules' generic store (docs/plan-module-storage.md). A module declares scopes of its data
 * (module.json `storage`); the account chooses, scope by scope, where each one lives:
 *  - 'server': on the server (/api/data/<module>/_store, App\Service\Storage\DataStore), shared by its devices;
 *  - 'local': on each device (platform.localStore), never sent anywhere.
 * The module writes the same way in both (openStore). A scope declared `perItem` lets an item live
 * elsewhere than the scope says: a list merges both places.
 */

export type StorageMode = 'local' | 'server'

/** A document as the module sees it: where it lives, with its data. */
export interface StoreItem<T = unknown> {
	id: string
	collection: string
	data: T
	updatedAt: number
	mode: StorageMode
}

/** Not reachable here: the scope is local and this device has no local store (Android, for now). */
export class StoreUnavailableError extends Error {
	constructor() {
		super('This data is kept on each device, and this one cannot hold it.')
	}
}

// --- the account's modes, per module

const modes = new Map<string, Record<string, StorageMode>>()
const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
	revision++
	for (const cb of listeners) cb()
}

/** Reads (again) where a module's scopes live, for this account. */
export async function loadModes(module: string): Promise<Record<string, StorageMode>> {
	const res = await api<{ data: Record<string, StorageMode> | [] }>(`/api/${module}/_store`)
	const read = Array.isArray(res.data) ? {} : res.data
	modes.set(module, read)
	changed()
	return read
}

function scopeOf(module: string, scope: string): StorageScope {
	const found = MODULE_MANIFESTS.find(m => m.id === module)?.storage?.scopes.find(s => s.id === scope)
	if (!found) throw new Error(`store: ${module} declares no scope "${scope}"`)
	return found
}

/** Where a scope lives: the account's choice, else the module's default. */
export function modeOf(module: string, scope: string): StorageMode {
	return modes.get(module)?.[scope] ?? scopeOf(module, scope).default
}

/** Re-renders when a module's modes change (read, or a move). */
export function useStorageModes(module: string): number {
	useEffect(() => {
		if (!modes.has(module)) void loadModes(module).catch(() => {})
	}, [module])
	return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => revision)
}

// --- this device's account key (the local store is per account and server)

let accountKey: Promise<string> | null = null

/** A stable key for the signed-in account on this server (a hash: no name on the disk). */
export function account(): Promise<string> {
	accountKey ??= (async () => {
		const { token } = await getAuthData()
		const payload = token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { username?: string } : {}
		const bytes = new TextEncoder().encode(`${getApiBaseUrl()}|${payload.username ?? ''}`)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
		return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
	})()
	return accountKey
}

// --- the two places

/** One place a scope's data can live: the server, or this device. */
interface Place {
	list(collection?: string): Promise<StoredDocument[]>
	get(collection: string, id: string): Promise<StoredDocument | null>
	put(documents: StoredDocument[]): Promise<void>
	delete(collection: string, id: string): Promise<void>
	purge(): Promise<void>
	files(): Promise<Array<StoredFile & { url?: string }>>
	putFile(path: string, body: Uint8Array): Promise<void>
	readFile(path: string): Promise<Uint8Array | null>
	fileUrl(path: string): Promise<string | null>
	deleteFile(path: string): Promise<void>
}

/**
 * On the server, a document's data is sealed by this device (the account's data key, `v1:`), its
 * place as associated data: the server keeps `{ $sealed: 'v1:…' }` and can't read it
 * (docs/plan-storage-encryption.md § 6, step 4). A document from before, in clear, reads as it is.
 */
const where = (module: string, scope: string, collection: string, id: string) => `store/${module}/${scope}/${collection}/${id}`

async function sealDocuments(module: string, scope: string, documents: StoredDocument[]): Promise<StoredDocument[]> {
	const keys = await requireDataKeys()
	return documents.map(d => ({ ...d, data: { $sealed: seal(keys.fields, where(module, scope, d.collection, d.id), JSON.stringify(d.data)) } }))
}

async function openDocument(module: string, scope: string, d: StoredDocument): Promise<StoredDocument> {
	const sealed = (d.data as { $sealed?: unknown } | null)?.$sealed
	if (!isSealed(sealed)) return d
	const keys = await requireDataKeys()
	return { ...d, data: JSON.parse(open(keys.fields, where(module, scope, d.collection, d.id), sealed)) }
}

function serverPlace(module: string, scope: string): Place {
	const base = `/api/${module}/_store/${scope}`
	let urls: Map<string, string> | null = null
	const fileUrls = async () => {
		urls ??= new Map((await api<{ data: Array<StoredFile & { url: string }> }>(`${base}/files`)).data.map(f => [f.path, f.url]))
		return urls
	}
	return {
		list: async collection => {
			const documents = (await api<{ data: StoredDocument[] }>(collection ? `${base}?collection=${collection}` : base)).data
			return Promise.all(documents.map(d => openDocument(module, scope, d)))
		},
		get: async (collection, id) => {
			let document: StoredDocument
			try {
				document = (await api<{ data: StoredDocument }>(`${base}/docs/${collection}/${encodeURIComponent(id)}`)).data
			}
			catch {
				return null
			}
			return openDocument(module, scope, document)
		},
		put: async documents => {
			const sealed = await sealDocuments(module, scope, documents)
			for (let i = 0; i < sealed.length; i += 100) {
				await api(`${base}/docs`, { method: 'POST', body: JSON.stringify(sealed.slice(i, i + 100)) })
			}
		},
		delete: async (collection, id) => { await api(`${base}/docs/${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' }) },
		purge: async () => { await api(base, { method: 'DELETE' }) },
		files: async () => {
			const list = (await api<{ data: Array<StoredFile & { url: string }> }>(`${base}/files`)).data
			urls = new Map(list.map(f => [f.path, f.url]))
			return list
		},
		putFile: async (path, body) => {
			await apiUpload(`${base}/files/${path}`, body)
			urls = null
		},
		readFile: async path => {
			const url = (await fileUrls()).get(path)
			if (!url) return null
			const res = await fetch(url)
			return res.ok ? new Uint8Array(await res.arrayBuffer()) : null
		},
		fileUrl: async path => (await fileUrls()).get(path) ?? null,
		deleteFile: async path => {
			await api(`${base}/files/${path}`, { method: 'DELETE' })
			urls = null
		}
	}
}

function localPlace(module: string, scope: string): Place {
	const local = platform.localStore
	const blobs = new Map<string, string>()
	const call = async <R>(run: (store: NonNullable<typeof local>, key: string) => Promise<R>): Promise<R> => {
		if (!local) throw new StoreUnavailableError()
		return run(local, await account())
	}
	return {
		list: collection => call((s, a) => s.list(a, module, scope, collection)),
		get: (collection, id) => call((s, a) => s.get(a, module, scope, collection, id)),
		put: documents => call((s, a) => s.put(a, module, scope, documents)),
		delete: (collection, id) => call((s, a) => s.delete(a, module, scope, collection, id)),
		purge: () => call((s, a) => s.purge(a, module, scope)),
		files: () => call((s, a) => s.files(a, module, scope)),
		putFile: (path, body) => call((s, a) => s.putFile(a, module, scope, path, body)),
		readFile: path => call((s, a) => s.getFile(a, module, scope, path)),
		fileUrl: async path => {
			const known = blobs.get(path)
			if (known) return known
			const body = await call((s, a) => s.getFile(a, module, scope, path))
			if (!body) return null
			const url = URL.createObjectURL(new Blob([body as BlobPart]))
			blobs.set(path, url)
			return url
		},
		deleteFile: path => call((s, a) => s.deleteFile(a, module, scope, path))
	}
}

function place(module: string, scope: string, mode: StorageMode): Place {
	return mode === 'server' ? serverPlace(module, scope) : localPlace(module, scope)
}

// --- what a module uses

export interface Store {
	/** where the scope lives now */
	readonly mode: StorageMode
	list<T = unknown>(collection: string): Promise<Array<StoreItem<T>>>
	get<T = unknown>(collection: string, id: string): Promise<StoreItem<T> | null>
	/** writes an item (where the scope lives, or `mode` for a perItem scope) */
	put<T = unknown>(collection: string, id: string, data: T, options?: { mode?: StorageMode }): Promise<void>
	delete(collection: string, id: string): Promise<void>
	putFile(path: string, body: Uint8Array | Blob): Promise<void>
	/** a URL an <img>/<audio> can load, null when there is no such file */
	fileUrl(path: string): Promise<string | null>
	deleteFile(path: string): Promise<void>
}

const tag = (mode: StorageMode) => (d: StoredDocument): StoreItem<never> => ({ ...d, data: d.data as never, mode })

/**
 * A scope of a module's store, where the account placed it. Read the mode again on each call: a
 * move between places changes it.
 */
export function openStore(module: string, scope: string): Store {
	const declared = scopeOf(module, scope)
	const current = () => modeOf(module, scope)
	const other = (mode: StorageMode): StorageMode => (mode === 'server' ? 'local' : 'server')
	const others = () => declared.perItem && declared.modes.length > 1 ? [other(current())] : []

	return {
		get mode() { return current() },
		async list<T>(collection: string) {
			const items = (await place(module, scope, current()).list(collection)).map(tag(current()))
			for (const mode of others()) {
				try {
					items.push(...(await place(module, scope, mode).list(collection)).map(tag(mode)))
				}
				catch (err) {
					if (!(err instanceof StoreUnavailableError)) throw err
				}
			}
			return items.sort((a, b) => b.updatedAt - a.updatedAt) as Array<StoreItem<T>>
		},
		async get<T>(collection: string, id: string) {
			for (const mode of [current(), ...others()]) {
				const found = await place(module, scope, mode).get(collection, id).catch(err => { if (err instanceof StoreUnavailableError) return null; throw err })
				if (found) return tag(mode)(found) as StoreItem<T>
			}
			return null
		},
		async put<T>(collection: string, id: string, data: T, options?: { mode?: StorageMode }) {
			const mode = declared.perItem && options?.mode && declared.modes.includes(options.mode) ? options.mode : current()
			await place(module, scope, mode).put([{ collection, id, data, updatedAt: Date.now() }])
			// an item moved to the other place leaves the first one
			if (declared.perItem) {
				for (const elsewhere of [current(), ...others()].filter(m => m !== mode)) {
					await place(module, scope, elsewhere).delete(collection, id).catch(() => {})
				}
			}
		},
		async delete(collection: string, id: string) {
			for (const mode of [current(), ...others()]) {
				await place(module, scope, mode).delete(collection, id).catch(err => { if (!(err instanceof StoreUnavailableError)) throw err })
			}
		},
		async putFile(path: string, body: Uint8Array | Blob) {
			const bytes = body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body
			await place(module, scope, current()).putFile(path, bytes)
		},
		fileUrl: path => place(module, scope, current()).fileUrl(path),
		deleteFile: path => place(module, scope, current()).deleteFile(path)
	}
}

// --- moving a scope between the server and this device

export interface MoveProgress {
	step: 'reading' | 'documents' | 'files' | 'checking' | 'cleaning' | 'done'
	done: number
	total: number
}

/**
 * Moves a scope's data to the other place: copies every document and file, checks them there,
 * switches the scope's mode (for the account), then empties the first place. From the server, the
 * data lands on this device; to the server, this device's data goes up (another device's local
 * data stays there).
 */
export async function moveScope(module: string, scope: string, to: StorageMode, onProgress: (p: MoveProgress) => void = () => {}): Promise<void> {
	const from = modeOf(module, scope)
	if (from === to) return
	const source = place(module, scope, from)
	const target = place(module, scope, to)

	onProgress({ step: 'reading', done: 0, total: 0 })
	const documents = await source.list()
	const files = await source.files()
	const total = documents.length + files.length

	onProgress({ step: 'documents', done: 0, total })
	await target.put(documents)
	onProgress({ step: 'files', done: documents.length, total })
	let done = documents.length
	for (const file of files) {
		const body = await source.readFile(file.path)
		if (!body) throw new Error(`${file.path}: unreadable`)
		await target.putFile(file.path, body)
		onProgress({ step: 'files', done: ++done, total })
	}

	onProgress({ step: 'checking', done, total })
	const landed = await target.list()
	const landedIds = new Set(landed.map(d => `${d.collection}/${d.id}`))
	const missing = documents.filter(d => !landedIds.has(`${d.collection}/${d.id}`))
	if (missing.length) throw new Error(`${missing.length} documents did not land: nothing was removed`)
	const landedFiles = new Map((await target.files()).map(f => [f.path, f.sha256]))
	const wrong = files.filter(f => landedFiles.get(f.path) !== f.sha256)
	if (wrong.length) throw new Error(`${wrong.length} files did not land: nothing was removed`)

	await api(`/api/${module}/_store/${scope}/mode`, { method: 'PUT', body: JSON.stringify({ mode: to }) })
	modes.set(module, { ...modes.get(module), [scope]: to })
	changed()

	onProgress({ step: 'cleaning', done, total })
	await source.purge()
	onProgress({ step: 'done', done, total })
}
