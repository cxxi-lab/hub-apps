import { registerPlugin } from '@capacitor/core'
import type { LocalStoreApi, StoredDocument, StoredFile } from './types'

/**
 * The modules' store on Android (LocalStorePlugin.java): SQLite per account and module, files next
 * to it. A document's data crosses the bridge as JSON text, a file as base64.
 */

type At = { account: string; module: string; scope: string }
type NativeDocument = { collection: string; id: string; data: string; updatedAt: number }

interface LocalStorePlugin {
	list(options: At & { collection?: string }): Promise<{ documents: NativeDocument[] }>
	get(options: At & { collection: string; id: string }): Promise<{ document: NativeDocument | null }>
	put(options: At & { documents: NativeDocument[] }): Promise<void>
	delete(options: At & { collection: string; id: string }): Promise<void>
	purge(options: At): Promise<void>
	files(options: At): Promise<{ files: StoredFile[] }>
	putFile(options: At & { path: string; body: string }): Promise<void>
	getFile(options: At & { path: string }): Promise<{ body: string | null }>
	deleteFile(options: At & { path: string }): Promise<void>
}

const Native = registerPlugin<LocalStorePlugin>('LocalStore')

const toDocument = (d: NativeDocument): StoredDocument => ({ collection: d.collection, id: d.id, data: JSON.parse(d.data), updatedAt: Number(d.updatedAt) })

function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return btoa(binary)
}

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0))

export function createLocalStore(): LocalStoreApi {
	return {
		list: (account, module, scope, collection) =>
			Native.list({ account, module, scope, ...(collection ? { collection } : {}) }).then(r => r.documents.map(toDocument)),
		get: (account, module, scope, collection, id) =>
			Native.get({ account, module, scope, collection, id }).then(r => r.document ? toDocument(r.document) : null),
		put: (account, module, scope, documents) =>
			Native.put({ account, module, scope, documents: documents.map(d => ({ collection: d.collection, id: d.id, data: JSON.stringify(d.data ?? null), updatedAt: d.updatedAt })) }),
		delete: (account, module, scope, collection, id) => Native.delete({ account, module, scope, collection, id }),
		purge: (account, module, scope) => Native.purge({ account, module, scope }),
		files: (account, module, scope) => Native.files({ account, module, scope }).then(r => r.files),
		putFile: (account, module, scope, path, body) => Native.putFile({ account, module, scope, path, body: toBase64(body) }),
		getFile: (account, module, scope, path) => Native.getFile({ account, module, scope, path }).then(r => r.body === null ? null : fromBase64(r.body)),
		deleteFile: (account, module, scope, path) => Native.deleteFile({ account, module, scope, path }),
	}
}
