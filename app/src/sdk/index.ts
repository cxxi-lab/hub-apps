/**
 * The hubby SDK (@cxxi-lab/hubbyware-sdk), as one hubby gets it. Everything is the contract's
 * (contract.ts, one instance shared by all, `shared/sdk-contract.js`) but the API calls: they are
 * made as the hubby, with its token — its own, and the web socle's lookups (integrations, players) — (core/hubby/tokens.ts), so the server knows which hubby makes
 * each one. This entry is instantiated once per hubby: a hubby bundle imports
 * `shared/sdk.js?hubby=<id>` (hubby-cli), its sources in development the same (build/sharedRuntime.ts).
 * Imported without a hubby (an older bundle, the app itself): the calls are the account's.
 */
import { accountCaller, api as accountApi, type ApiCall } from '@core/api/client'
import { createTasks, type TasksApi } from '@core/api/tasks'
import { getApiBaseUrl as baseUrl } from '@core/api/baseUrl'
import { createOAuth } from '@core/hubby/oauth'
import { apiStream as accountStream, type StreamEventHandler } from '@core/api/stream'
import { hubbyApi } from '@core/hubby/tokens'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import { ensureIntegrationForUrl as ensureIntegration } from '@shared/web/integrations'
import { getPlayerConfig as playerConfig, type PlayerConfig } from '@shared/web/players'
import { syncPlayerBlocklist as syncBlocklist } from '@shared/web/playerBlocklist'
import { collection as hubbyCollection } from '@core/hubby/collections'
import { useAmountsBlurred as amountsBlurred, useHubbyVisible as hubbyVisible } from '@core/privacy/hidden'
import { Amount as AppAmount } from '@core/privacy/Amount'
import { createElement, type ReactNode } from 'react'

export * from './contract'

const hubby = new URL(import.meta.url).searchParams.get('hubby')
const bound = hubby && /^[a-z0-9-]{1,80}$/.test(hubby) ? hubbyApi(hubby) : null

/** A call to the server's API, as the hubby: its JSON (nothing on a 204), an ApiError otherwise. */
export function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
	return bound ? bound.api<T>(path, options, retry) : accountApi<T>(path, options, retry)
}

/**
 * The hubby's tasks (server docs/plan-tasks.md): a capability's call run in the background, the
 * hubby choosing at each call. In sync, `await api(path, options)`: a promise of the result (an
 * operation always run as a task is awaited the same, unseen). As a task:
 *
 *     const task = await tasks.start('/api/cap/scrape/video', { method: 'POST', body })
 *     task.on(state => …)                          // a hook: queued, running (progress), finished
 *     for await (const state of task.events()) …   // or a stream, until it is finished
 *     const video = await task.result()            // what the call would have given
 *     await task.cancel()
 *
 * `tasks.list()`: its tasks, running and recent (24 h); `tasks.get(id)`: one again (after a reload).
 */
export const tasks: TasksApi = bound ? bound.tasks : createTasks(accountCaller)

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
 * docs/plan-reseau-vpn.md). `<webview partition={webviewPartition} …>`. A webview outside its
 * hubby's partition is refused (an SDK imported without a hubby: none).
 */
export const webviewPartition = bound ? `persist:hubby:${hubby}` : ''

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

/**
 * One of the hubby's collections (docs/spec-hubby.md § 5): `collection(name)`, the hubby being the
 * SDK's (the common API, docs/plan-isolation.md § 2); `collection(hubby, name)` still accepted
 * here, until the hubbies run isolated. `T`: its declared fields.
 */
export function collection<T extends object>(hubbyOrName: string, name?: string) {
	if (name !== undefined) return hubbyCollection<T>(hubbyOrName, name)
	if (!bound || !hubby) throw new Error('collection(name) needs the SDK of a hubby (shared/sdk.js?hubby=<id>)')
	return hubbyCollection<T>(hubby, hubbyOrName)
}

/** Whether the hubby is shown (its Privacy: hidden unless revealed); another's by its id. */
export function useHubbyVisible(id?: string): boolean {
	return hubbyVisible(id ?? hubby ?? '')
}

/** Whether the hubby's amounts are blurred (its Privacy); another's by its id. */
export function useAmountsBlurred(id?: string): boolean {
	return amountsBlurred(id ?? hubby ?? '')
}

/** An amount of the hubby, blurred when its Privacy asks for it (another hubby's: `hubby`). */
export function Amount(props: { hubby?: string, children: ReactNode, className?: string }) {
	return createElement(AppAmount, { ...props, hubby: props.hubby ?? hubby ?? '' })
}

/**
 * A hubby's definition, in the form of its manifest (docs/plan-isolation.md § 2): in the app, the
 * manifest itself; in its frame, the same definition runs isolated (navItems, routes, providers).
 */
export function defineHubby<D extends object>(definition: D): D {
	return definition
}
