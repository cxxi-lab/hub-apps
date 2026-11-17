/**
 * The hubby SDK (@cxxi-lab/hubbyware-sdk), as one hubby gets it. Everything is the contract's
 * (contract.ts, one instance shared by all, `shared/sdk-contract.js`) but the API calls: they are
 * made as the hubby, with its token — its own, and the web socle's lookups (integrations, players) — (core/hubby/tokens.ts), so the server knows which hubby makes
 * each one. This entry is instantiated once per hubby: a hubby bundle imports
 * `shared/sdk.js?hubby=<id>` (hubby-cli), its sources in development the same (build/sharedRuntime.ts).
 * Imported without a hubby (an older bundle, the app itself): the calls are the account's.
 */
import { api as accountApi, type ApiCall } from '@core/api/client'
import { getApiBaseUrl as baseUrl } from '@core/api/baseUrl'
import { createOAuth } from '@core/hubby/oauth'
import { apiStream as accountStream, type StreamEventHandler } from '@core/api/stream'
import { hubbyApi } from '@core/hubby/tokens'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import { ensureIntegrationForUrl as ensureIntegration } from '@shared/web/integrations'
import { getPlayerConfig as playerConfig, type PlayerConfig } from '@shared/web/players'
import { syncPlayerBlocklist as syncBlocklist } from '@shared/web/playerBlocklist'

export * from './contract'

const hubby = new URL(import.meta.url).searchParams.get('hubby')
const bound = hubby && /^[a-z0-9-]{1,80}$/.test(hubby) ? hubbyApi(hubby) : null

/** A call to the server's API, as the hubby: its JSON (nothing on a 204), an ApiError otherwise. */
export function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
	return bound ? bound.api<T>(path, options, retry) : accountApi<T>(path, options, retry)
}

/**
 * Opens an authenticated server-sent event stream, as the hubby — over fetch, so it can POST a
 * body and carry the token — and resolves once the server closes it.
 */
export function apiStream(path: string, options: RequestInit, onEvent: StreamEventHandler, retry = true): Promise<void> {
	return bound ? bound.apiStream(path, options, onEvent, retry) : accountStream(path, options, onEvent, retry)
}

/**
 * The server's base URL, for the URLs a hubby hands an <img>, a <video>, a player (signed media).
 * The same for every path (`path`: kept for the hubbies passing it).
 */
export function getApiBaseUrl(_path?: string): string {
	return baseUrl()
}

/**
 * The partition of the hubby's <webview>s (desktop): its own session, its sites' cookies and storage
 * apart from the other hubbies', going out through the VPN when it declares so (server
 * docs/plan-reseau-vpn.md). `<webview partition={webviewPartition} …>`.
 */
export const webviewPartition = bound ? `persist:hubby:${hubby}` : 'persist:browse'

/**
 * For a hubby going out through the VPN: whether its tunnel is up, so its webviews and players can
 * load (until then the shell blocks them: render them once this is true).
 */
export function useTunnelReady(): boolean {
	const vpn = useVpnStatus()
	return vpn.status === 'connected' && (vpn.hubby == null || !bound || vpn.hubby === hubby)
}

const call: ApiCall = (path, options) => api(path, options)

/** Applies the website integration (cookies, CDN referer) of a URL's site before a webview or the native player loads it. */
export function ensureIntegrationForUrl(rawUrl: string): Promise<void> {
	return ensureIntegration(call, rawUrl)
}

/**
 * The player config for a domain, null when the back has no scripts for the
 * site (it is then loaded as-is). A failed lookup resolves null too, and is
 * retried next time.
 */
export function getPlayerConfig(domain: string): Promise<PlayerConfig | null> {
	return playerConfig(call, domain)
}

/** Makes sure the shell holds the back's current player blocklist before a player loads a site (once per session). */
export function syncPlayerBlocklist(): Promise<void> {
	return syncBlocklist(call)
}

/**
 * The account's connections at a provider (Google, Microsoft), for what the hubby declares
 * (hubby.json `oauth`): list them, connect an account, get access tokens narrowed to its scopes.
 */
export const oauth = createOAuth(call)
