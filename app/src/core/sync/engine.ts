import { platform } from '@platform'
import { api } from '@core/api/client'
import { requireDataKeys } from '@core/crypto/dataKey'
import { open, seal } from '@core/crypto/format'
import { encryptsAtRest } from '@core/module/declarations'
import { modelsOf } from '@core/crypto/documents'
import { uuidv7 } from '@core/crypto/format'
import { remoteCollection } from '@core/hubby/collections'
import { onSyncEvent } from '@core/notifications/notifications'
import { account } from '@core/storage/account'
import { Clock, parse } from './hlc'
import { isMigrated, LOCAL_FIRST_KEY, onTrial } from './mode'
import { Replica, type DocState, type Operation } from './replica'
import { openOperation, sealOperation, type Envelope } from './envelope'

/**
 * A local-first module on this device (docs/plan-local-first.md § 3): its replica, kept in the
 * device's base (platform.localStore, scope `sync`), synced through the relay (/api/data/<module>/_sync):
 *  - a write here is applied at once, stored, sent shortly after (sealed whole);
 *  - the relay's new operations are read when it says so (Mercure), on focus, and every minute;
 *  - on trial, the server's collections (Mongo) are kept up to date too, so that a device not
 *    local-first yet still reads the same data (its own writes don't come back here);
 *  - migrated (mode.ts), each device catches up once with what the server's collections have that
 *    the log hasn't (written by a device not on trial), then they are no longer written.
 * The first time, the relay's log is read first: when another device already started it, this
 * one takes everything from it; only an empty log is seeded with the module's documents on the
 * server (copying them on every new device would rewrite them with a later clock, and could undo a
 * change the server's copy missed).
 * A module declaring `encryptAtRest` (module.json) has what is stored here sealed with the data key
 * (each document, and the state with the operations waiting): the device's base holds no clear
 * value of it.
 */

const SCOPE = 'sync'
const META = '_meta'
const POLL_MS = 60_000
const PUSH_DELAY_MS = 300

interface Meta {
	clock: string
	position: number
	outbox: Operation[]
	imported: boolean
	/** the server's collections read once since the module was migrated */
	caughtUp?: boolean
}

function deviceId(): string {
	const KEY = 'hub.sync.device'
	let id = localStorage.getItem(KEY)
	if (!id || !/^[a-z0-9]{8,40}$/.test(id)) {
		id = Array.from(crypto.getRandomValues(new Uint8Array(10)), b => (b % 36).toString(36)).join('')
		localStorage.setItem(KEY, id)
	}
	return id
}

const engines = new Map<string, ModuleSync>()

/** The module's engine, started on first use. */
export function engine(module: string): ModuleSync {
	let found = engines.get(module)
	if (!found) engines.set(module, found = new ModuleSync(module))
	return found
}

// switched on or off in another window (Settings): this one reloads to take it
window.addEventListener('storage', e => { if (e.key === LOCAL_FIRST_KEY) location.reload() })

export class ModuleSync {
	readonly ready: Promise<void>
	readonly device = deviceId()
	replica!: Replica
	private position = 0
	private dirty = new Set<string>()
	private saving: Promise<void> | null = null
	private pushTimer: ReturnType<typeof setTimeout> | null = null
	private syncing: Promise<void> | null = null
	private again = false
	private imported = false
	private caughtUp = false
	/** the key sealing what is stored here (`encryptAtRest`), else null */
	private restKey: Uint8Array | null = null

	constructor(readonly module: string) {
		this.ready = this.start()
	}

	private async start(): Promise<void> {
		const local = platform.localStore
		if (!local) throw new Error('No local base on this device')
		const key = await account()
		const raw = await local.list(key, this.module, SCOPE)
		// a base once encrypted stays so, even if the module stops asking
		if (encryptsAtRest(this.module) || raw.some(d => isSealedAtRest(d.data))) this.restKey = (await requireDataKeys()).fields
		const stored = raw.map(d => ({ ...d, raw: d.data, data: this.opened(d.collection, d.id, d.data) }))
		const meta = stored.find(d => d.collection === META && d.id === 'state')?.data as Meta | undefined

		this.replica = new Replica(new Clock(this.device, Date.now, meta?.clock), uuidv7)
		const byCollection = new Map<string, Record<string, DocState>>()
		for (const doc of stored) {
			if (doc.collection === META) continue
			if (!byCollection.has(doc.collection)) byCollection.set(doc.collection, {})
			byCollection.get(doc.collection)![doc.id] = doc.data as DocState
		}
		for (const [collection, docs] of byCollection) this.replica.load(collection, docs)
		this.position = meta?.position ?? 0
		if (meta?.outbox?.length) this.replica.requeue(meta.outbox)

		this.replica.subscribe((collection, doc) => this.markDirty(collection, doc))
		// stored in clear before the module asked for encryption: sealed at the next save
		if (this.restKey) for (const d of stored) if (d.collection !== META && !isSealedAtRest(d.raw)) this.markDirty(d.collection, d.id)
		this.imported = meta?.imported ?? false
		this.caughtUp = meta?.caughtUp ?? false
		// a first start: its data before the first screen, when the relay answers (offline: later)
		if (!this.imported) await this.sync()

		onSyncEvent((module, position) => { if (module === this.module && position > this.position) void this.sync() })
		window.addEventListener('focus', () => { void this.sync() })
		// the phone's app back in front
		document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void this.sync() })
		// back online: what was written meanwhile goes at once
		window.addEventListener('online', () => { void this.sync() })
		setInterval(() => { void this.sync() }, POLL_MS)
		void this.sync()
	}

	/** The log still empty: the module's documents on the server become its first operations. */
	private async importFromServer(): Promise<void> {
		let count = 0
		for (const collection of modelsOf(this.module).keys()) {
			const docs = await remoteCollection<Record<string, unknown>>(this.module, collection).findAll()
			for (const doc of docs) {
				const { id, _createdAt, _updatedAt, _version, ...fields } = doc
				void _version
				this.replica.putAt(collection, String(id), fields, Date.parse(String(_createdAt)), Date.parse(String(_updatedAt)))
				count++
			}
		}
		console.log(`[sync] ${this.module}: ${count} document(s) imported from the server`)
	}

	/**
	 * Migrated (once per device): what the server's collections have that the log hasn't, written
	 * there by a device not on trial, written here. Only a document changed there after its last
	 * change here, and only the fields that differ: the trial's own copies there match and are
	 * left. Documents gone there are kept here (a deletion there can't be told from a copy that
	 * failed). Returns whether anything was written.
	 */
	private async catchUp(): Promise<boolean> {
		let changed = 0
		let missing = 0
		for (const collection of modelsOf(this.module).keys()) {
			const docs = await remoteCollection<Record<string, unknown>>(this.module, collection).findAll()
			const there = new Set<string>()
			for (const doc of docs) {
				const { id, _createdAt, _updatedAt, _version, ...fields } = doc
				void _createdAt; void _version
				there.add(String(id))
				const state = this.replica.state(collection, String(id))
				if (state && Date.parse(String(_updatedAt)) <= parse(state.updated).wall) continue
				const here = this.replica.get(collection, String(id)) ?? {}
				const differ = Object.fromEntries(Object.entries(fields).filter(([f, v]) => !same(v, here[f])))
				if (Object.keys(differ).length === 0) continue
				this.replica.put(collection, String(id), differ)
				changed++
			}
			missing += this.replica.list(collection).filter(d => !there.has(d.id)).length
		}
		console.log(`[sync] ${this.module}: caught up with the server, ${changed} document(s) taken` + (missing ? `, ${missing} not there (kept)` : ''))
		return changed > 0
	}

	/** A write made here (localCollection): stored, then sent. */
	wrote(): void {
		void this.save()
		if (this.pushTimer) clearTimeout(this.pushTimer)
		this.pushTimer = setTimeout(() => { void this.sync() }, PUSH_DELAY_MS)
	}

	/** Sends what is waiting, then reads what is new, until nothing is. One at a time. */
	sync(): Promise<void> {
		if (this.syncing) {
			this.again = true
			return this.syncing
		}
		this.syncing = (async () => {
			try {
				do {
					this.again = false
					await this.push()
					await this.pull()
					if (!this.imported) {
						// the log read: empty, this device seeds it; else it already has everything
						if (this.position === 0) {
							await this.importFromServer()
							this.caughtUp = true
							this.again = true
						}
						this.imported = true
					}
					if (!this.caughtUp && isMigrated(this.module)) {
						if (await this.catchUp()) this.again = true
						this.caughtUp = true
					}
				} while (this.again)
			}
			catch (err) {
				console.warn(`[sync] ${this.module}: not synced`, err)
			}
			finally {
				this.syncing = null
				await this.save()
			}
		})()
		return this.syncing
	}

	private async push(): Promise<void> {
		const ops = this.replica.takeOutbox()
		if (ops.length === 0) return
		try {
			const keys = await requireDataKeys()
			for (let i = 0; i < ops.length; i += 500) {
				const batch = ops.slice(i, i + 500)
				const envelopes = batch.map(op => sealOperation(keys.fields, this.module, op))
				await api(`/api/data/${this.module}/_sync`, {
					method: 'POST',
					body: JSON.stringify({ device: this.device, ops: envelopes.map(({ id, sealed }) => ({ id, sealed })) })
				})
			}
		}
		catch (err) {
			this.replica.requeue(ops)
			throw err
		}
	}

	private async pull(): Promise<void> {
		const keys = await requireDataKeys()
		let more = true
		while (more) {
			const page = await api<{ data: { ops: Array<Envelope & { device: string, position: number }>, position: number, more: boolean } }>(
				`/api/data/${this.module}/_sync?since=${this.position}`
			).then(r => r.data)
			// this device's own come back too: applying them again changes nothing
			const ops = page.ops.map(e => openOperation(keys.fields, { id: e.id, module: this.module, sealed: e.sealed }))
			const drifted = this.replica.receive(ops)
			if (drifted.length) console.warn(`[sync] ${this.module}: ${drifted.length} operation(s) from a clock far ahead`, drifted.map(o => o.hlc))
			this.position = page.position
			more = page.more
		}
	}

	private where(collection: string, id: string): string {
		return `local/${this.module}/${collection}/${id}`
	}

	/** As stored here: sealed (`encryptAtRest`) or as is. */
	private sealed(collection: string, id: string, data: unknown): unknown {
		return this.restKey ? { sealed: seal(this.restKey, this.where(collection, id), JSON.stringify(data)) } : data
	}

	/** As read back: opened when sealed (a store from before `encryptAtRest`: as is). */
	private opened(collection: string, id: string, data: unknown): unknown {
		if (!isSealedAtRest(data)) return data
		return JSON.parse(open(this.restKey!, this.where(collection, id), data.sealed))
	}

	private markDirty(collection: string, doc: string): void {
		this.dirty.add(`${collection}\u0000${doc}`)
	}

	/** Stores the documents changed and the state (clock, position, what is waiting). */
	private save(): Promise<void> {
		const run = async () => {
			const local = platform.localStore!
			const key = await account()
			const now = Date.now()
			const docs = [...this.dirty].map(entry => {
				const [collection, id] = entry.split('\u0000')
				return { collection, id, data: this.sealed(collection, id, this.replica.state(collection, id)), updatedAt: now }
			})
			this.dirty.clear()
			const meta: Meta = { clock: this.replica.clock.current(), position: this.position, outbox: this.replica.pending(), imported: this.imported, caughtUp: this.caughtUp }
			await local.put(key, this.module, SCOPE, [...docs, { collection: META, id: 'state', data: this.sealed(META, 'state', meta), updatedAt: now }])
		}
		// one after the other: a later save never lands before an earlier one
		this.saving = (this.saving ?? Promise.resolve()).then(run, run)
		return this.saving
	}
}

const isSealedAtRest = (data: unknown): data is { sealed: string } =>
	typeof data === 'object' && data !== null && typeof (data as { sealed?: unknown }).sealed === 'string' && Object.keys(data).length === 1

/** Two field values alike (as JSON; missing and null alike). */
function same(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** For the trial: the server's collections (Mongo) kept up to date with this device's writes. */
export async function mirror(module: string, op: Operation, existed: boolean): Promise<void> {
	if (!onTrial(module)) return
	const remote = remoteCollection<Record<string, unknown>>(module, op.collection)
	try {
		if (op.kind === 'delete') await remote.remove(op.doc)
		else if (existed) await remote.update(op.doc, op.fields ?? {})
		else await remote.createWithId(op.doc, op.fields ?? {})
	}
	catch (err) {
		console.warn(`[sync] ${module}/${op.collection} ${op.doc}: not mirrored on the server`, err)
	}
}
