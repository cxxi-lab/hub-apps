// Website integrations (cookies, CDN referer) applied before a webview / the
// native player loads a site. Shared by Private's webviews (its Browse, its players) and the phone's
// native player.
import { getApiBaseUrl } from '@core/api/baseUrl'
import { getAuthData, resetAuthState } from '@core/auth/authState'
import { tryRefreshToken } from '@core/auth/refresh'
import type { WebsiteIntegration } from '@platform'
import { platform } from '@platform'

// Per-requested-domain cache. `matchedHost` is the integration that won the
// server-side suffix match, or null when no integration applies (negative
// cache). `updatedAt` mirrors the matched integration's server-side timestamp.
interface DomainEntry {
	matchedHost: string | null
	updatedAt: number | null
}

const localState = new Map<string, DomainEntry>()
const pending = new Map<string, Promise<void>>()
let initialized = false

function suffixMatches(domain: string, host: string): boolean {
	return domain === host || domain.endsWith('.' + host)
}

async function authedFetch(path: string): Promise<Response> {
	const { token } = await getAuthData()
	const res = await fetch(`${getApiBaseUrl()}${path}`, {
		headers: token ? { Authorization: `Bearer ${token}` } : {}
	})
	if (res.status === 401) {
		const refreshed = await tryRefreshToken()
		if (!refreshed) {
			await resetAuthState()
			throw new Error('Unauthorized')
		}
		return authedFetch(path)
	}
	return res
}

async function fetchAndApply(domain: string): Promise<void> {
	const existing = pending.get(domain)
	if (existing) return existing

	const p = (async () => {
		try {
			const res = await authedFetch(`/api/cap/web/integrations/${domain}`)
			if (res.status === 404) {
				localState.set(domain, { matchedHost: null, updatedAt: null })
				return
			}
			if (!res.ok) {
				throw new Error(`HTTP ${res.status}`)
			}
			const body = await res.json() as {
				data: { host: string; updatedAt: number; integration: WebsiteIntegration }
			}
			localState.set(domain, { matchedHost: body.data.host, updatedAt: body.data.updatedAt })
			await platform.applyIntegration({
				host: body.data.host,
				integration: body.data.integration,
				updatedAt: body.data.updatedAt,
			})
		}
		catch (err) {
			console.warn('[integrations] fetch failed for', domain, err)
			throw err
		}
	})()

	pending.set(domain, p)
	try { await p } finally { pending.delete(domain) }
}

export async function initIntegrations(): Promise<void> {
	if (initialized) return
	initialized = true

	// Main process already replayed its disk cache via applyAll() at startup.
	// We just sync the manifest to detect drift.
	syncIntegrations().catch(err => console.warn('[integrations] background sync failed:', err))
}

export async function syncIntegrations(): Promise<void> {
	const res = await authedFetch('/api/cap/web/integrations')
	if (!res.ok) throw new Error(`HTTP ${res.status}`)
	const body = await res.json() as { data: Array<{ host: string; updatedAt: number }> }

	const manifest = new Map<string, number>()
	for (const { host, updatedAt } of body.data) manifest.set(host, updatedAt)

	const mainSeen = new Set((await platform.listIntegrations()).map(e => e.host))

	const domainsToRefetch = new Set<string>()

	for (const [domain, entry] of localState) {
		if (entry.matchedHost !== null) {
			const serverUpdatedAt = manifest.get(entry.matchedHost)
			if (serverUpdatedAt === undefined) {
				// Integration was removed server-side.
				localState.delete(domain)
				continue
			}
			if (serverUpdatedAt > (entry.updatedAt ?? 0)) {
				domainsToRefetch.add(domain)
			}
		}
		else {
			// Negative cache — re-validate if any manifest host now matches.
			for (const host of manifest.keys()) {
				if (suffixMatches(domain, host)) {
					domainsToRefetch.add(domain)
					break
				}
			}
		}
	}

	// Main process side: drop any host the server no longer knows about.
	for (const host of mainSeen) {
		if (!manifest.has(host)) {
			await platform.removeIntegration(host).catch(() => {})
		}
	}

	for (const domain of domainsToRefetch) {
		await fetchAndApply(domain).catch(() => {})
	}
}

export async function ensureIntegrationForUrl(rawUrl: string): Promise<void> {
	if (!initialized) await initIntegrations()

	let host: string
	try { host = new URL(rawUrl).hostname.toLowerCase() }
	catch { return }

	if (localState.has(host)) return
	await fetchAndApply(host).catch(() => {})
}

/**
 * Sync probe — true if the domain has already been checked (positive or
 * negative). Lets call-sites skip the async await on hot paths.
 */
export function isIntegrationKnownSync(rawUrl: string): boolean {
	try {
		const host = new URL(rawUrl).hostname.toLowerCase()
		return localState.has(host)
	}
	catch {
		return true
	}
}
