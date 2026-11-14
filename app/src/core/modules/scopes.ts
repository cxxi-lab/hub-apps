import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@core/api/client'

/**
 * The modules' scopes for this account (docs/spec-module.md § 4): what each asks for, what was
 * allowed. Loaded once, kept in sync between the app's windows (Settings is one on desktop).
 * Families: `app:` the platform's services, `module:` another module's features, `user:` the
 * account's own data.
 */

export interface RequestedScope {
	scope: string
	/** the sentence the account is asked to allow */
	label: string
	family: 'app' | 'module' | 'user'
	/** comes with the module (an official one's platform service): never asked, never revoked */
	builtIn: boolean
}

export interface ModuleScopes {
	requested: RequestedScope[]
	granted: string[]
}

const CHANNEL = 'hub-module-scopes'
let state: Record<string, ModuleScopes> | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: Record<string, ModuleScopes>) {
	state = next
	listeners.forEach(l => l())
}

let channel: BroadcastChannel | null = null
try {
	channel = new BroadcastChannel(CHANNEL)
	channel.onmessage = e => set(e.data as Record<string, ModuleScopes>)
}
catch { /* each window reads them at start */ }

export function loadScopes(): Promise<void> {
	loading ??= api<{ data: Record<string, ModuleScopes> }>('/api/hub/modules/scopes')
		.then(r => set(r.data))
		.catch(err => {
			loading = null
			console.warn('[scopes] not read', err)
		})
	return loading
}

function changed(module: string, entry: ModuleScopes) {
	const next = { ...(state ?? {}), [module]: entry }
	set(next)
	channel?.postMessage(next)
}

export async function grantScopes(module: string, scopes: string[]): Promise<void> {
	const r = await api<{ data: ModuleScopes }>(`/api/hub/modules/${module}/scopes`, { method: 'POST', body: JSON.stringify({ scopes }) })
	changed(module, r.data)
}

export async function revokeScope(module: string, scope: string): Promise<void> {
	const r = await api<{ data: ModuleScopes }>(`/api/hub/modules/${module}/scopes/${encodeURIComponent(scope)}`, { method: 'DELETE' })
	changed(module, r.data)
}

/** Every module's scopes (null until read). */
export function useModuleScopes(): Record<string, ModuleScopes> | null {
	useEffect(() => { void loadScopes() }, [])
	return useSyncExternalStore(
		l => { listeners.add(l); return () => listeners.delete(l) },
		() => state
	)
}

/** Did the account allow the module this scope? (Unknown yet: no.) */
export function hasScope(scopes: Record<string, ModuleScopes> | null, module: string, scope: string): boolean {
	return !!scopes?.[module]?.granted.includes(scope)
}

/** The scopes the account still has to allow before the module can be added. */
export function missingScopes(scopes: Record<string, ModuleScopes> | null, module: string): RequestedScope[] {
	const entry = scopes?.[module]
	if (!entry) return []
	return entry.requested.filter(r => !r.builtIn && !entry.granted.includes(r.scope))
}
