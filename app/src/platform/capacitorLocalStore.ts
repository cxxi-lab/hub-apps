import { registerPlugin } from '@capacitor/core'
import type { LocalStoreApi, StoredDocument } from './types'

/**
 * The device's base on Android (LocalStorePlugin.java): SQLite per account and module. A document's
 * data crosses the bridge as JSON text.
 */

type At = { account: string; module: string; scope: string }
type NativeDocument = { collection: string; id: string; data: string; updatedAt: number }

interface LocalStorePlugin {
	list(options: At & { collection?: string }): Promise<{ documents: NativeDocument[] }>
	get(options: At & { collection: string; id: string }): Promise<{ document: NativeDocument | null }>
	put(options: At & { documents: NativeDocument[] }): Promise<void>
	delete(options: At & { collection: string; id: string }): Promise<void>
	purge(options: At): Promise<void>
}

const Native = registerPlugin<LocalStorePlugin>('LocalStore')

const toDocument = (d: NativeDocument): StoredDocument => ({ collection: d.collection, id: d.id, data: JSON.parse(d.data), updatedAt: Number(d.updatedAt) })

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
	}
}
