import { storageFromOf } from './declarations'

/**
 * A hubby's own key-value storage on this device (docs/plan-isolation.md, phase 4a): what it kept
 * in the app's localStorage (a list, its choices), kept here under `hubby-storage:<id>:<key>`, the
 * same whether it runs in the app or isolated (its frame has no storage of its own: it gets a
 * snapshot at start, its writes come back by message). The keys it kept in the app's storage before
 * (hubby.json `storageFrom`) are copied once.
 */

const prefix = (hubby: string) => `hubby-storage:${hubby}:`
const MAX_VALUE = 1_000_000

function migrate(hubby: string): void {
	for (const key of storageFromOf(hubby)) {
		try {
			const own = prefix(hubby) + key
			if (localStorage.getItem(own) !== null) continue
			const before = localStorage.getItem(key)
			if (before !== null) localStorage.setItem(own, before)
		}
		catch { /* a convenience: nothing to copy */ }
	}
}

/** Everything the hubby keeps, by key (its frame's snapshot). */
export function storageSnapshot(hubby: string): Record<string, string> {
	migrate(hubby)
	const out: Record<string, string> = {}
	try {
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i)
			if (key?.startsWith(prefix(hubby))) out[key.slice(prefix(hubby).length)] = localStorage.getItem(key) ?? ''
		}
	}
	catch { /* no storage: an empty snapshot */ }
	return out
}

export function storageGet(hubby: string, key: string): string | null {
	migrate(hubby)
	try { return localStorage.getItem(prefix(hubby) + key) }
	catch { return null }
}

/** null: removed. */
export function storageSet(hubby: string, key: string, value: string | null): void {
	if (typeof key !== 'string' || key === '' || key.length > 200) throw new Error('invalid storage key')
	if (value !== null && (typeof value !== 'string' || value.length > MAX_VALUE)) throw new Error('a storage value is a string (1 MB at most)')
	try {
		if (value === null) localStorage.removeItem(prefix(hubby) + key)
		else localStorage.setItem(prefix(hubby) + key, value)
	}
	catch (err) {
		console.warn(`[hubbies] ${hubby}: not stored`, err)
	}
}
