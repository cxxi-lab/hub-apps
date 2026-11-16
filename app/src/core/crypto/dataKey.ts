import { useEffect, useSyncExternalStore } from 'react'
import { api, ApiError } from '@core/api/client'
import { getApiBaseUrl, onBaseUrlChange, serverIdentity } from '@core/api/baseUrl'
import { platform } from '@platform'
import { DataKeyMissingError } from './documents'
import { base64url, deriveKeys, fromBase64url, newDataKey, type DataKeys } from './format'

/**
 * The account's data key on this device (docs/plan-storage-encryption.md § 2). The first device
 * of an account makes it and records its fingerprint on the server (which never sees the key); the
 * others get it from a linked device (./link.ts) or the recovery key. Kept in the device's secret
 * store (platform.getDeviceSecret), per server, by fingerprint.
 */

export type DataKeyState =
	| { status: 'loading' }
	/** this device holds the account's key */
	| { status: 'ready', keyId: string }
	/** the account has a key, this device doesn't: to be linked */
	| { status: 'missing', keyId: string }
	| { status: 'error', error: string }

const DATA_KEY_PATH = '/api/hub/data-key'
let state: DataKeyState = { status: 'loading' }
let current: { raw: Uint8Array, keys: DataKeys } | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function setState(next: DataKeyState): void {
	state = next
	listeners.forEach(l => l())
}

// by the server's identity (serverIdentity): the same across its renames
const secretName = () => `data-key@${serverIdentity(getApiBaseUrl(DATA_KEY_PATH))}`

/** fingerprint → key (base64url): the keys this device holds for this server's accounts */
async function storedKeys(): Promise<Record<string, string>> {
	try {
		const value = await platform.getDeviceSecret(secretName())
		return value ? JSON.parse(value) : {}
	}
	catch (err) {
		console.error('[data-key] the device secret cannot be read', err)
		return {}
	}
}

async function storeKey(raw: Uint8Array, keyId: string): Promise<void> {
	const keys = await storedKeys()
	keys[keyId] = base64url(raw)
	await platform.setDeviceSecret(secretName(), JSON.stringify(keys))
}

async function forgetKey(keyId: string): Promise<void> {
	const keys = await storedKeys()
	delete keys[keyId]
	await platform.setDeviceSecret(secretName(), Object.keys(keys).length ? JSON.stringify(keys) : null)
}

function use(raw: Uint8Array): DataKeys {
	const keys = deriveKeys(raw)
	current = { raw, keys }
	setState({ status: 'ready', keyId: keys.id })
	onReady.forEach(cb => cb())
	return keys
}

async function load(): Promise<void> {
	try {
		const { keyId } = await api<{ keyId: string | null }>(DATA_KEY_PATH)
		const stored = await storedKeys()
		if (keyId && stored[keyId]) {
			use(fromBase64url(stored[keyId]))
			return
		}
		if (keyId) {
			current = null
			setState({ status: 'missing', keyId })
			return
		}
		// the account's first device: a new key, kept here before it is claimed (never lost)
		const raw = newDataKey()
		const { id } = deriveKeys(raw)
		await storeKey(raw, id)
		try {
			await api(DATA_KEY_PATH, { method: 'POST', body: JSON.stringify({ keyId: id }) })
			use(raw)
		}
		catch (err) {
			await forgetKey(id)
			// another device claimed one first: this one gets linked to it
			if (err instanceof ApiError && err.status === 409) {
				loading = null
				return load()
			}
			throw err
		}
	}
	catch (err) {
		current = null
		setState({ status: 'error', error: err instanceof Error ? err.message : String(err) })
		loading = null
	}
}

/** Loads the key once (again after an error, or when asked). */
export function loadDataKey(force = false): Promise<void> {
	if (force || !loading) loading = load()
	return loading
}

/** The keys, or DataKeyMissingError when this device isn't linked yet. */
export async function requireDataKeys(): Promise<DataKeys> {
	await loadDataKey()
	if (state.status === 'error') await loadDataKey(true)
	if (current) return current.keys
	if (state.status === 'error') throw new Error(`The data key could not be loaded: ${state.error}`)
	throw new DataKeyMissingError()
}

/** The keys if this device holds them (no wait, no error). */
export const currentDataKeys = (): DataKeys | null => current?.keys ?? null

/** The raw key: for a device link and the recovery key only. */
export const rawDataKey = (): Uint8Array | null => current?.raw ?? null

/**
 * A key from elsewhere (a linked device, the recovery key): kept only if it is the account's.
 */
export async function adoptDataKey(raw: Uint8Array): Promise<void> {
	const { keyId } = await api<{ keyId: string | null }>(DATA_KEY_PATH)
	const { id } = deriveKeys(raw)
	if (keyId !== id) throw new Error(keyId ? 'This is not the key of this account' : 'This account has no data key yet')
	await storeKey(raw, id)
	use(raw)
}

export function useDataKey(): DataKeyState {
	useEffect(() => { void loadDataKey() }, [])
	// another window (desktop) may have linked this device meanwhile
	useEffect(() => {
		const refocus = () => { if (state.status === 'missing') void loadDataKey(true) }
		window.addEventListener('focus', refocus)
		return () => window.removeEventListener('focus', refocus)
	}, [])
	return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb) }, () => state)
}

/** Called each time the key becomes available (the sealing of what's left in clear). */
const onReady = new Set<() => void>()
export function whenDataKeyReady(cb: () => void): () => void {
	onReady.add(cb)
	if (current) cb()
	return () => onReady.delete(cb)
}

/** Forgets the key in memory (signed out; another account may sign in): it stays on the device. */
export function resetDataKey(): void {
	current = null
	loading = null
	setState({ status: 'loading' })
}

onBaseUrlChange(resetDataKey)
