import { app, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The device's base for the modules' data (docs/plan-local-first.md): what the local-first sync
 * keeps here (app/src/core/sync, scope `sync`). One SQLite database per account and module, its
 * documents by scope and collection: userData/store/<account>/<module>.sqlite.
 * The app reaches it through IPC (platform.localStore).
 */

const ROOT = join(app.getPath('userData'), 'store')
const ACCOUNT = /^[a-f0-9]{16,64}$/
const MODULE = /^[a-z0-9-]{1,40}$/
const SCOPE = /^[a-z0-9-]{1,40}$/
const COLLECTION = /^[a-z0-9_-]{1,40}$/
const DOC_ID = /^[A-Za-z0-9._:-]{1,64}$/

export interface StoredDocument {
	collection: string
	id: string
	data: unknown
	updatedAt: number
}

const databases = new Map<string, DatabaseSync>()

function check(value: unknown, pattern: RegExp, what: string): string {
	if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`store: bad ${what}`)
	return value
}

function db(account: string, module: string): DatabaseSync {
	const key = `${account}/${module}`
	let found = databases.get(key)
	if (!found) {
		mkdirSync(join(ROOT, account), { recursive: true })
		found = new DatabaseSync(join(ROOT, account, `${module}.sqlite`))
		found.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE IF NOT EXISTS document (
				scope TEXT NOT NULL,
				collection TEXT NOT NULL,
				id TEXT NOT NULL,
				data TEXT NOT NULL,
				updated_at INTEGER NOT NULL,
				PRIMARY KEY (scope, collection, id)
			);
		`)
		databases.set(key, found)
	}
	return found
}

type Row = { collection: string, id: string, data: string, updated_at: number }
const toDocument = (row: Row): StoredDocument => ({ collection: row.collection, id: row.id, data: JSON.parse(row.data), updatedAt: Number(row.updated_at) })

function list(account: string, module: string, scope: string, collection?: string): StoredDocument[] {
	const rows = collection
		? db(account, module).prepare('SELECT collection, id, data, updated_at FROM document WHERE scope = ? AND collection = ? ORDER BY updated_at DESC').all(scope, collection)
		: db(account, module).prepare('SELECT collection, id, data, updated_at FROM document WHERE scope = ? ORDER BY updated_at DESC').all(scope)
	return (rows as Row[]).map(toDocument)
}

function get(account: string, module: string, scope: string, collection: string, id: string): StoredDocument | null {
	const row = db(account, module).prepare('SELECT collection, id, data, updated_at FROM document WHERE scope = ? AND collection = ? AND id = ?').get(scope, collection, id) as Row | undefined
	return row ? toDocument(row) : null
}

/** Writes documents; the last write wins (an older one than what is stored is left out). */
function put(account: string, module: string, scope: string, documents: StoredDocument[]): void {
	const write = db(account, module).prepare(`
		INSERT INTO document (scope, collection, id, data, updated_at) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (scope, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
		WHERE excluded.updated_at >= document.updated_at
	`)
	db(account, module).exec('BEGIN')
	try {
		for (const d of documents) {
			write.run(scope, check(d.collection, COLLECTION, 'collection'), check(d.id, DOC_ID, 'id'), JSON.stringify(d.data ?? null), Math.trunc(Number(d.updatedAt) || Date.now()))
		}
		db(account, module).exec('COMMIT')
	}
	catch (err) {
		db(account, module).exec('ROLLBACK')
		throw err
	}
}

function remove(account: string, module: string, scope: string, collection: string, id: string): void {
	db(account, module).prepare('DELETE FROM document WHERE scope = ? AND collection = ? AND id = ?').run(scope, collection, id)
}

/** Empties a scope here. */
function purge(account: string, module: string, scope: string): void {
	db(account, module).prepare('DELETE FROM document WHERE scope = ?').run(scope)
}

export function setupLocalStore(): void {
	// every call: (account, module, scope, …) checked before anything touches the disk
	const at = (account: unknown, module: unknown, scope: unknown) =>
		[check(account, ACCOUNT, 'account'), check(module, MODULE, 'module'), check(scope, SCOPE, 'scope')] as const

	ipcMain.handle('store:list', (_e, account, module, scope, collection?: unknown) =>
		list(...at(account, module, scope), collection === undefined || collection === null ? undefined : check(collection, COLLECTION, 'collection')))
	ipcMain.handle('store:get', (_e, account, module, scope, collection, id) =>
		get(...at(account, module, scope), check(collection, COLLECTION, 'collection'), check(id, DOC_ID, 'id')))
	ipcMain.handle('store:put', (_e, account, module, scope, documents: unknown) => {
		if (!Array.isArray(documents)) throw new Error('store: bad documents')
		put(...at(account, module, scope), documents as StoredDocument[])
	})
	ipcMain.handle('store:delete', (_e, account, module, scope, collection, id) =>
		remove(...at(account, module, scope), check(collection, COLLECTION, 'collection'), check(id, DOC_ID, 'id')))
	ipcMain.handle('store:purge', (_e, account, module, scope) => purge(...at(account, module, scope)))
}
