import { app, ipcMain } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The modules' generic store, on this device (docs/plan-module-storage.md): a scope whose data the
 * account keeps local lives here, never on the server. One SQLite database per account and module
 * (its documents, by scope and collection), its files next to it:
 *   userData/store/<account>/<module>.sqlite, userData/store/<account>/<module>/<scope>/<path>.
 * The app reaches it through IPC (platform.localStore); the server side is App\Core\Storage\DataStore.
 */

const ROOT = join(app.getPath('userData'), 'store')
const ACCOUNT = /^[a-f0-9]{16,64}$/
const MODULE = /^[a-z0-9-]{1,40}$/
const SCOPE = /^[a-z0-9-]{1,40}$/
const COLLECTION = /^[a-z0-9_-]{1,40}$/
const DOC_ID = /^[A-Za-z0-9._:-]{1,64}$/
const FILE = /^[A-Za-z0-9._-]{1,120}(\/[A-Za-z0-9._-]{1,120}){0,3}$/
const MAX_FILE = 50 * 1024 * 1024

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

function scopeDir(account: string, module: string, scope: string): string {
	return join(ROOT, account, module, scope)
}

function filePath(account: string, module: string, scope: string, path: string): string {
	if (path.includes('..')) throw new Error('store: bad path')
	return join(scopeDir(account, module, scope), path)
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

/** Empties a scope here (its data moved to the server): documents and files. */
function purge(account: string, module: string, scope: string): void {
	db(account, module).prepare('DELETE FROM document WHERE scope = ?').run(scope)
	rmSync(scopeDir(account, module, scope), { recursive: true, force: true })
}

function files(account: string, module: string, scope: string): { path: string, size: number, sha256: string }[] {
	const root = scopeDir(account, module, scope)
	if (!existsSync(root)) return []
	const found: { path: string, size: number, sha256: string }[] = []
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const full = join(dir, name)
			if (statSync(full).isDirectory()) walk(full)
			else if (!name.endsWith('.partial')) {
				const body = readFileSync(full)
				found.push({ path: relative(root, full).split('\\').join('/'), size: body.length, sha256: createHash('sha256').update(body).digest('hex') })
			}
		}
	}
	walk(root)
	return found.sort((a, b) => a.path.localeCompare(b.path))
}

function putFile(account: string, module: string, scope: string, path: string, body: Uint8Array): void {
	if (body.byteLength > MAX_FILE) throw new Error('store: file too large')
	const target = filePath(account, module, scope, path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(`${target}.partial`, body)
	renameSync(`${target}.partial`, target)
}

function readFile(account: string, module: string, scope: string, path: string): Uint8Array | null {
	const target = filePath(account, module, scope, path)
	return existsSync(target) ? new Uint8Array(readFileSync(target)) : null
}

function removeFile(account: string, module: string, scope: string, path: string): void {
	rmSync(filePath(account, module, scope, path), { force: true })
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
	ipcMain.handle('store:files', (_e, account, module, scope) => files(...at(account, module, scope)))
	ipcMain.handle('store:file:put', (_e, account, module, scope, path, body: unknown) => {
		if (!(body instanceof Uint8Array)) throw new Error('store: bad file')
		putFile(...at(account, module, scope), check(path, FILE, 'path'), body)
	})
	ipcMain.handle('store:file:get', (_e, account, module, scope, path) => readFile(...at(account, module, scope), check(path, FILE, 'path')))
	ipcMain.handle('store:file:delete', (_e, account, module, scope, path) => removeFile(...at(account, module, scope), check(path, FILE, 'path')))
}
