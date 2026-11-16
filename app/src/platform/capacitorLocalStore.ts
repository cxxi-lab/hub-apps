import { registerPlugin } from '@capacitor/core'
import type { LocalStoreApi, StoredDocument } from './types'

/**
 * The device's base on Android (LocalStorePlugin.java): SQLite per account and hubby. A document's
 * data crosses the bridge as JSON text.
 */

type At = { account: string; hubby: string; scope: string }
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
		list: (account, hubby, scope, collection) =>
			Native.list({ account, hubby, scope, ...(collection ? { collection } : {}) }).then(r => r.documents.map(toDocument)),
		get: (account, hubby, scope, collection, id) =>
			Native.get({ account, hubby, scope, collection, id }).then(r => r.document ? toDocument(r.document) : null),
		put: (account, hubby, scope, documents) =>
			Native.put({ account, hubby, scope, documents: documents.map(d => ({ collection: d.collection, id: d.id, data: JSON.stringify(d.data ?? null), updatedAt: d.updatedAt })) }),
		delete: (account, hubby, scope, collection, id) => Native.delete({ account, hubby, scope, collection, id }),
		purge: (account, hubby, scope) => Native.purge({ account, hubby, scope }),
	}
}
