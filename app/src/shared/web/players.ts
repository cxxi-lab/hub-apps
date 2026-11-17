import { ApiError } from '@core/api/client'

/** A call to the API as the hubby asking (the SDK binds it: src/sdk/index.ts). */
export type ApiCall = <T>(path: string, options?: RequestInit) => Promise<T>

/** A site's player scripts, served by the back (the web socle, Resources/<host>/). */
export interface PlayerScripts {
	/** run on the video page (page mode) to isolate the player */
	page: string | null
	/** run on a bare embed player (embed mode) */
	embed: string | null
	pause: string | null
}

export interface PlayerConfig {
	/** the host whose scripts apply to the requested domain */
	host: string
	scripts: PlayerScripts
}

async function fetchPlayerConfig(call: ApiCall, domain: string): Promise<PlayerConfig | null> {
	try {
		const res = await call<{ data: PlayerConfig }>(`/api/cap/web/players/${domain}`)
		return res.data
	}
	catch (err) {
		if (err instanceof ApiError && err.status === 404) return null
		throw err
	}
}

// One lookup per domain per session; a failed lookup isn't cached.
const configs = new Map<string, Promise<PlayerConfig | null>>()

/**
 * The player config for a domain, null when the back has no scripts for the
 * site (it is then loaded as-is). A failed lookup resolves null too, and is
 * retried next time.
 */
export function getPlayerConfig(call: ApiCall, domain: string): Promise<PlayerConfig | null> {
	const key = domain.toLowerCase()
	const cached = configs.get(key)
	if (cached) return cached
	const pending = fetchPlayerConfig(call, key).catch(err => {
		console.warn('[player] scripts lookup failed for', key, err)
		configs.delete(key)
		return null
	})
	configs.set(key, pending)
	return pending
}

/** Hosts the player blocks (ads, trackers), compiled by the back from public blocklists. */
export interface PlayerBlocklist {
	version: string
	hosts: string[]
}

/** The current list, or null when `knownVersion` is already the latest (or the back has none yet). */
export async function fetchPlayerBlocklist(call: ApiCall, knownVersion: string | null): Promise<PlayerBlocklist | null> {
	try {
		const res = await call<{ data: PlayerBlocklist }>('/api/cap/web/player-blocklist', {
			headers: knownVersion ? { 'If-None-Match': `"${knownVersion}"` } : {}
		})
		return res.data
	}
	catch (err) {
		if (err instanceof ApiError && (err.status === 304 || err.status === 404)) return null
		throw err
	}
}
