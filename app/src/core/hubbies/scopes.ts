import { useEffect, useSyncExternalStore } from 'react'
import { api } from '@core/api/client'

/**
 * The hubbies' scopes for this account (docs/spec-hubby.md § 4): what each asks for, what was
 * allowed. Loaded once, kept in sync between the app's windows (Settings is one on desktop).
 * Families: `app:` the platform's services, `hubby:` another hubby's features, `user:` the
 * account's own data.
 */

export interface RequestedScope {
	scope: string
	/** the sentence the account is asked to allow */
	label: string
	family: 'app' | 'hubby' | 'user'
	/** comes with the hubby (an official one's platform service): never asked, never revoked */
	builtIn: boolean
}

export interface HubbyScopes {
	requested: RequestedScope[]
	granted: string[]
}

const CHANNEL = 'hub-module-scopes'
let state: Record<string, HubbyScopes> | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: Record<string, HubbyScopes>) {
	state = next
	listeners.forEach(l => l())
}

let channel: BroadcastChannel | null = null
try {
	channel = new BroadcastChannel(CHANNEL)
	channel.onmessage = e => set(e.data as Record<string, HubbyScopes>)
}
catch { /* each window reads them at start */ }

export function loadScopes(): Promise<void> {
	loading ??= api<{ data: Record<string, HubbyScopes> }>('/api/hub/hubbies/scopes')
		.then(r => set(r.data))
		.catch(err => {
			loading = null
			console.warn('[scopes] not read', err)
		})
	return loading
}

function changed(hubby: string, entry: HubbyScopes) {
	const next = { ...(state ?? {}), [hubby]: entry }
	set(next)
	channel?.postMessage(next)
}

export async function grantScopes(hubby: string, scopes: string[]): Promise<void> {
	const r = await api<{ data: HubbyScopes }>(`/api/hub/hubbies/${hubby}/scopes`, { method: 'POST', body: JSON.stringify({ scopes }) })
	changed(hubby, r.data)
}

export async function revokeScope(hubby: string, scope: string): Promise<void> {
	const r = await api<{ data: HubbyScopes }>(`/api/hub/hubbies/${hubby}/scopes/${encodeURIComponent(scope)}`, { method: 'DELETE' })
	changed(hubby, r.data)
}

/** Every hubby's scopes (null until read). */
export function useHubbyScopes(): Record<string, HubbyScopes> | null {
	useEffect(() => { void loadScopes() }, [])
	return useSyncExternalStore(
		l => { listeners.add(l); return () => listeners.delete(l) },
		() => state
	)
}

/** Did the account allow the hubby this scope? (Unknown yet: no.) */
export function hasScope(scopes: Record<string, HubbyScopes> | null, hubby: string, scope: string): boolean {
	return !!scopes?.[hubby]?.granted.includes(scope)
}

/** The scopes the account still has to allow before the hubby can be added. */
export function missingScopes(scopes: Record<string, HubbyScopes> | null, hubby: string): RequestedScope[] {
	const entry = scopes?.[hubby]
	if (!entry) return []
	return entry.requested.filter(r => !r.builtIn && !entry.granted.includes(r.scope))
}
