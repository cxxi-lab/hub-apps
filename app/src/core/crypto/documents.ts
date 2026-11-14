import { blindIndex, isSealed, open, seal, type DataKeys } from './format'

/**
 * Which fields of a hubby's collections are encrypted, and sealing / opening a document by them
 * (docs/plan-storage-encryption.md § 3). The declarations come with each module, never from the
 * server: its models.json, downloaded with it and checked against its signed catalogue entry (or
 * its sources' models/, in development). A server that lied about them would get values in clear.
 */

interface FieldSpec {
	type: string
	/** true / 'equality': sealed here, by the device; 'server': sealed by the server (sent in clear) */
	encrypted?: boolean | 'equality' | 'server'
	fields?: Record<string, FieldSpec>
	items?: FieldSpec
}

export interface ModelFile {
	collection: string
	version: number
	fields: Record<string, FieldSpec>
}

export interface EncryptedModel {
	module: string
	collection: string
	version: number
	fields: Record<string, FieldSpec>
	/** the top-level fields with an encrypted part */
	encrypted: string[]
	/** the encrypted "equality" fields (top level) */
	equality: string[]
	/** the module's former ids: values sealed under them are still opened (then sealed again) */
	formerly: string[]
}

/** Sealed by the device (a field sealed by the server is sent and read in clear). */
const byDevice = (field: FieldSpec): boolean => field.encrypted === true || field.encrypted === 'equality'

const hasEncrypted = (field: FieldSpec): boolean =>
	byDevice(field) || Object.values(field.fields ?? {}).some(hasEncrypted) || (!!field.items && hasEncrypted(field.items))

const MODELS = new Map<string, EncryptedModel>()
const listeners = new Set<() => void>()

/** A module's models (as it ships them: models.json, by collection), registered as it loads. */
export function registerModels(module: string, models: Record<string, ModelFile> | ModelFile[], formerly: string[] = []): void {
	let added = false
	for (const model of Object.values(models)) {
		const encrypted = Object.entries(model.fields).filter(([, f]) => hasEncrypted(f)).map(([name]) => name)
		if (encrypted.length === 0) continue
		MODELS.set(`${module}/${model.collection}`, {
			module, collection: model.collection, version: model.version, fields: model.fields, encrypted, formerly,
			equality: Object.entries(model.fields).filter(([, f]) => f.encrypted === 'equality').map(([name]) => name)
		})
		added = true
	}
	if (added) for (const listener of listeners) listener()
}

/** Called when a module brought models with encrypted fields. */
export function onModelsRegistered(listener: () => void): () => void {
	listeners.add(listener)
	return () => { listeners.delete(listener) }
}

/** The model of a collection with encrypted fields, or null (nothing to do). */
export const encryptedModel = (module: string, collection: string): EncryptedModel | null => MODELS.get(`${module}/${collection}`) ?? null

export const encryptedModels = (): EncryptedModel[] => [...MODELS.values()]

const where = (model: EncryptedModel, id: string, field: string) => `${model.module}/${model.collection}/${id}/${field}`

function sealValue(keys: DataKeys, field: FieldSpec, at: string, value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (byDevice(field)) {
		if (typeof value !== 'string') return value
		// already sealed (a value read back and written again unchanged): kept
		return isSealed(value) ? value : seal(keys.fields, at, value)
	}
	if (field.type === 'object' && field.fields && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
		for (const [name, child] of Object.entries(field.fields)) {
			if (name in out) out[name] = sealValue(keys, child, `${at}.${name}`, out[name])
		}
		return out
	}
	if (field.type === 'array' && field.items && Array.isArray(value)) {
		return value.map(item => sealValue(keys, field.items!, `${at}[]`, item))
	}
	return value
}

function openValue(keys: DataKeys | null, field: FieldSpec, at: string, value: unknown): unknown {
	if (value === null || value === undefined) return value
	if (byDevice(field)) {
		if (!isSealed(value)) return value // stored before it was encrypted: its device seals it soon
		if (!keys) throw new DataKeyMissingError()
		return open(keys.fields, at, value)
	}
	if (field.type === 'object' && field.fields && typeof value === 'object' && !Array.isArray(value)) {
		const out: Record<string, unknown> = { ...(value as Record<string, unknown>) }
		for (const [name, child] of Object.entries(field.fields)) {
			if (name in out) out[name] = openValue(keys, child, `${at}.${name}`, out[name])
		}
		return out
	}
	if (field.type === 'array' && field.items && Array.isArray(value)) {
		return value.map(item => openValue(keys, field.items!, `${at}[]`, item))
	}
	return value
}

/** The fields to send, their encrypted parts sealed, and the blind indexes (`_bidx`). */
export function sealDocument(keys: DataKeys, model: EncryptedModel, id: string, data: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = { ...data }
	const bidx: Record<string, string> = {}
	for (const name of model.encrypted) {
		if (!(name in out)) continue
		const plain = out[name]
		if (model.equality.includes(name) && typeof plain === 'string') {
			if (isSealed(plain)) throw new Error(`${name}: give its value in clear (its blind index is made from it)`)
			bidx[name] = equalityIndex(keys, model, name, plain)
		}
		out[name] = sealValue(keys, model.fields[name], where(model, id, name), plain)
	}
	if (Object.keys(bidx).length > 0) out._bidx = bidx
	return out
}

const underFormerId = new WeakSet<object>()

/**
 * A document as read, its encrypted parts opened. Sealed under one of the module's former ids (it
 * was renamed): opened all the same, and marked to be sealed again (openedUnderFormerId).
 */
export function openDocument<T extends { id: string }>(keys: DataKeys | null, model: EncryptedModel, doc: T): T {
	const openAs = (module: string): T => {
		const out: Record<string, unknown> = { ...doc }
		for (const name of model.encrypted) {
			if (name in out) out[name] = openValue(keys, model.fields[name], where({ ...model, module }, doc.id, name), out[name])
		}
		return out as T
	}
	try {
		return openAs(model.module)
	}
	catch (err) {
		if (err instanceof DataKeyMissingError) throw err
		for (const former of model.formerly) {
			try {
				const opened = openAs(former)
				underFormerId.add(opened)
				return opened
			}
			catch {
				// not this one either
			}
		}
		throw err
	}
}

/** Whether a document was opened under a former id of its module (to be sealed again). */
export const openedUnderFormerId = (doc: object): boolean => underFormerId.has(doc)

/** Whether a stored document still holds encrypted fields in clear (imported, or older model). */
export function needsSealing(model: EncryptedModel, doc: Record<string, unknown>): boolean {
	const clear = (field: FieldSpec, value: unknown): boolean => {
		if (value === null || value === undefined) return false
		if (byDevice(field)) return typeof value === 'string' && !isSealed(value)
		if (field.type === 'object' && field.fields && typeof value === 'object') {
			return Object.entries(field.fields).some(([name, child]) => clear(child, (value as Record<string, unknown>)[name]))
		}
		if (field.type === 'array' && field.items && Array.isArray(value)) return value.some(item => clear(field.items!, item))
		return false
	}
	return model.encrypted.some(name => clear(model.fields[name], doc[name]))
}

export const equalityIndex = (keys: DataKeys, model: EncryptedModel, field: string, value: string): string =>
	blindIndex(keys.index, `${model.module}/${model.collection}/${field}`, value)

export class DataKeyMissingError extends Error {
	constructor() {
		super('This device has no data key yet: link it to one of your devices in Settings → Security')
		this.name = 'DataKeyMissingError'
	}
}
