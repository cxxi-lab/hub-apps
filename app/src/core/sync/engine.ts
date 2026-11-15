import { platform } from '@platform'
import { api } from '@core/api/client'
import { requireDataKeys } from '@core/crypto/dataKey'
import { modelsOf } from '@core/crypto/documents'
import { uuidv7 } from '@core/crypto/format'
import { remoteCollection } from '@core/hubby/collections'
import { onSyncEvent } from '@core/notifications/notifications'
import { account } from '@core/storage/store'
import { Clock } from './hlc'
import { LOCAL_FIRST_KEY } from './mode'
import { Replica, type DocState, type Operation } from './replica'
import { openOperation, sealOperation, type Envelope } from './envelope'

/**
 * A local-first module on this device (docs/plan-local-first.md § 3): its replica, kept in the
 * device's base (platform.localStore, scope `sync`), synced through the relay (/api/data/<module>/_sync):
 *  - a write here is applied at once, stored, sent shortly after (sealed whole);
 *  - the relay's new operations are read when it says so (Mercure), on focus, and every minute;
 *  - the trial keeps the server's collections (Mongo) up to date too, so that a device not
 *    local-first yet still reads the same data (its own writes don't come back here).
 * The first time, the module's documents are copied from the server.
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

	constructor(readonly module: string) {
		this.ready = this.start()
	}

	private async start(): Promise<void> {
		const local = platform.localStore
		if (!local) throw new Error('No local base on this device')
		const key = await account()
		const stored = await local.list(key, this.module, SCOPE)
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
		if (!meta?.imported) await this.importFromServer()

		onSyncEvent((module, position) => { if (module === this.module && position > this.position) void this.sync() })
		window.addEventListener('focus', () => { void this.sync() })
		// the phone's app back in front
		document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void this.sync() })
		setInterval(() => { void this.sync() }, POLL_MS)
		void this.sync()
	}

	/** The first time: the module's documents on the server, as this device's first writes. */
	private async importFromServer(): Promise<void> {
		let count = 0
		for (const collection of modelsOf(this.module).keys()) {
			const docs = await remoteCollection<Record<string, unknown>>(this.module, collection).findAll()
			for (const doc of docs) {
				const { id, _createdAt, _updatedAt, _version, ...fields } = doc
				void _createdAt; void _updatedAt; void _version
				this.replica.put(collection, String(id), fields)
				count++
			}
		}
		await this.save(true)
		console.log(`[sync] ${this.module}: ${count} document(s) imported from the server`)
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

	private markDirty(collection: string, doc: string): void {
		this.dirty.add(`${collection}\u0000${doc}`)
	}

	/** Stores the documents changed and the state (clock, position, what is waiting). */
	private save(imported = true): Promise<void> {
		const run = async () => {
			const local = platform.localStore!
			const key = await account()
			const now = Date.now()
			const docs = [...this.dirty].map(entry => {
				const [collection, id] = entry.split('\u0000')
				return { collection, id, data: this.replica.state(collection, id), updatedAt: now }
			})
			this.dirty.clear()
			const meta: Meta = { clock: this.replica.clock.current(), position: this.position, outbox: this.replica.pending(), imported }
			await local.put(key, this.module, SCOPE, [...docs, { collection: META, id: 'state', data: meta, updatedAt: now }])
		}
		// one after the other: a later save never lands before an earlier one
		this.saving = (this.saving ?? Promise.resolve()).then(run, run)
		return this.saving
	}
}

/** For the trial: the server's collections (Mongo) kept up to date with this device's writes. */
export async function mirror(module: string, op: Operation, existed: boolean): Promise<void> {
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
