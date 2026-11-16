import { platform } from '@platform'
import { api, TunnelDownError } from '@core/api/client'
import { requireDataKeys } from '@core/crypto/dataKey'
import { open, seal } from '@core/crypto/format'
import { encryptsAtRest, formerlyOf } from '@core/hubby/declarations'
import { uuidv7 } from '@core/crypto/format'
import { onSyncEvent } from '@core/notifications/notifications'
import { account } from '@core/storage/account'
import { Clock } from './hlc'
import { Replica, type DocState, type Operation } from './replica'
import { openOperation, sealOperation, type Envelope } from './envelope'

/**
 * A local-first module on this device (docs/plan-local-first.md § 3): its replica, kept in the
 * device's base (platform.localStore, scope `sync`), synced through the relay (/api/data/<module>/_sync):
 *  - a write here is applied at once, stored, sent shortly after (sealed whole);
 *  - the relay's new operations are read when it says so (Mercure), on focus, and every minute;
 * The first start waits for the log to be read (when online), so that a new device shows the
 * data its others wrote.
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

const engines = new Map<string, HubbySync>()

/** The module's engine, started on first use. */
export function engine(module: string): HubbySync {
	let found = engines.get(module)
	if (!found) engines.set(module, found = new HubbySync(module))
	return found
}

export class HubbySync {
	readonly ready: Promise<void>
	readonly device = deviceId()
	replica!: Replica
	private position = 0
	private dirty = new Set<string>()
	private saving: Promise<void> | null = null
	private pushTimer: ReturnType<typeof setTimeout> | null = null
	private syncing: Promise<void> | null = null
	private again = false
	/** the relay's log read once on this device (its first start waits for it, when online) */
	private imported = false
	/** a former id whose base was read at start: emptied once saved under this one */
	private movedFrom: string | null = null
	/** the key sealing what is stored here (`encryptAtRest`), else null */
	private restKey: Uint8Array | null = null

	constructor(readonly module: string) {
		this.ready = this.start()
	}

	private async start(): Promise<void> {
		const local = platform.localStore
		if (!local) throw new Error('No local base on this device')
		const key = await account()
		let raw = await local.list(key, this.module, SCOPE)
		// renamed (its module.json `formerly`): its base here still under a former id moves to this one
		let from = this.module
		if (raw.length === 0) {
			for (const former of formerlyOf(this.module)) {
				const old = await local.list(key, former, SCOPE)
				if (old.length > 0) {
					raw = old
					from = former
					break
				}
			}
		}
		// a base once encrypted stays so, even if the module stops asking
		if (encryptsAtRest(this.module) || raw.some(d => isSealedAtRest(d.data))) this.restKey = (await requireDataKeys()).fields
		const stored = raw.map(d => ({ ...d, raw: d.data, data: this.opened(d.collection, d.id, d.data, from) }))
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
		// moved from a former id: everything written again under this one, then the former base emptied
		if (from !== this.module) {
			for (const d of stored) if (d.collection !== META) this.markDirty(d.collection, d.id)
			this.movedFrom = from
			console.log(`[sync] ${this.module}: its base moved from ${from} (${stored.length} document(s))`)
		}
		this.imported = meta?.imported ?? false
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
					this.imported = true
				} while (this.again)
			}
			catch (err) {
				// a module behind the VPN, its tunnel closed: it syncs when it is open again
				if (!(err instanceof TunnelDownError)) console.warn(`[sync] ${this.module}: not synced`, err)
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
			// sealed before a rename (the log moved with the module): under a former id
			const ops = page.ops.map(e => openOperation(keys.fields, { id: e.id, module: this.module, sealed: e.sealed }, formerlyOf(this.module)))
			const drifted = this.replica.receive(ops)
			if (drifted.length) console.warn(`[sync] ${this.module}: ${drifted.length} operation(s) from a clock far ahead`, drifted.map(o => o.hlc))
			this.position = page.position
			more = page.more
		}
	}

	private where(collection: string, id: string, module = this.module): string {
		return `local/${module}/${collection}/${id}`
	}

	/** As stored here: sealed (`encryptAtRest`) or as is. */
	private sealed(collection: string, id: string, data: unknown): unknown {
		return this.restKey ? { sealed: seal(this.restKey, this.where(collection, id), JSON.stringify(data)) } : data
	}

	/** As read back: opened when sealed (a store from before `encryptAtRest`: as is). */
	private opened(collection: string, id: string, data: unknown, module = this.module): unknown {
		if (!isSealedAtRest(data)) return data
		return JSON.parse(open(this.restKey!, this.where(collection, id, module), data.sealed))
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
			const meta: Meta = { clock: this.replica.clock.current(), position: this.position, outbox: this.replica.pending(), imported: this.imported }
			await local.put(key, this.module, SCOPE, [...docs, { collection: META, id: 'state', data: this.sealed(META, 'state', meta), updatedAt: now }])
			if (this.movedFrom) {
				await local.purge(key, this.movedFrom, SCOPE)
				this.movedFrom = null
			}
		}
		// one after the other: a later save never lands before an earlier one
		this.saving = (this.saving ?? Promise.resolve()).then(run, run)
		return this.saving
	}
}

const isSealedAtRest = (data: unknown): data is { sealed: string } =>
	typeof data === 'object' && data !== null && typeof (data as { sealed?: unknown }).sealed === 'string' && Object.keys(data).length === 1
