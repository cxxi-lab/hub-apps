import { getApiBaseUrl } from './baseUrl'
import { lockedByServer, unlockHeaders } from '@core/privacy/locks'
import { getAuthData, resetAuthState } from '@core/auth/authState'
import { tryRefreshToken } from '@core/auth/refresh'
import { waitsForTunnel } from '@core/vpn/tunnel'

/**
 * Non-2xx response. `message` stays `HTTP <status>` (callers match on it); `detail`
 * carries the server's problem+json explanation when there is one.
 */
export class ApiError extends Error {
	constructor(public readonly status: number, public readonly detail: string | null) {
		super(`HTTP ${status}`)
	}
}

/** Best human-readable message for a caught error: server detail first. */
export function errorMessage(err: unknown, fallback = 'Request failed'): string {
	if (err instanceof ApiError) return err.detail ?? err.message
	return err instanceof Error ? err.message : fallback
}

/** A call for the VPN while its tunnel is down: not sent (core/vpn/tunnel.ts). */
export class TunnelDownError extends ApiError {
	constructor() {
		super(503, 'The VPN is not connected')
	}
}

/**
 * Who a call is made as: the account (the app itself) or a hubby (its token,
 * core/hubby/tokens.ts). `headers` gives its credentials for a path; `unauthorized` answers a 401
 * (true: send it again, once); `locked` a 423.
 */
export interface Caller {
	headers(path: string): Promise<Record<string, string>>
	unauthorized(): Promise<boolean>
	locked(path: string): void
}

/** The account: its token, refreshed on a 401 (signed out when it can't be), the unlock tokens. */
export const accountCaller: Caller = {
	async headers(path) {
		const { token } = await getAuthData()
		return { ...unlockHeaders(path), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
	},
	async unauthorized() {
		if (await tryRefreshToken()) return true
		await resetAuthState()
		return false
	},
	locked: lockedByServer
}

/** A call to the API, as the account or a hubby: its JSON (nothing on a 204), an ApiError otherwise. */
export async function request<T>(caller: Caller, path: string, options: RequestInit = {}, retry = true): Promise<T> {
	if (waitsForTunnel(path)) throw new TunnelDownError()

	// a FormData body (multipart): the browser sets the type, with its boundary
	const headers = {
		...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
		Accept: 'application/json',
		...options.headers,
		...await caller.headers(path)
	}

	const response = await fetch(`${getApiBaseUrl(path)}${path}`, { ...options, headers })

	if (response.status === 401) {
		if (retry && await caller.unauthorized()) return request<T>(caller, path, options, false)
		if (retry === false && caller === accountCaller) await resetAuthState()
		throw new Error('Unauthorized')
	}

	if (response.status === 423) caller.locked(path)

	if (!response.ok) {
		const body = await response.json().catch(() => null)
		throw new ApiError(response.status, typeof body?.detail === 'string' ? body.detail : null)
	}

	// 204: nothing to read
	if (response.status === 204) return undefined as T
	return response.json()
}

/** A call to the API as someone (the account, a hubby: the SDK binds each hubby's, src/sdk/index.ts). */
export type ApiCall = <T>(path: string, options?: RequestInit) => Promise<T>

/** A call as the account (the app itself). */
export function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
	return request<T>(accountCaller, path, options, retry)
}

/**
 * Sends raw bytes (a file), like api(): PUT by default. For the stores' files.
 */
export async function upload(caller: Caller, path: string, body: Uint8Array | Blob, method = 'PUT'): Promise<void> {
	if (waitsForTunnel(path)) throw new TunnelDownError()
	const response = await fetch(`${getApiBaseUrl(path)}${path}`, {
		method,
		body: body as BodyInit,
		headers: { 'Content-Type': 'application/octet-stream', ...await caller.headers(path) }
	})
	if (response.status === 423) caller.locked(path)
	if (!response.ok) throw new ApiError(response.status, null)
}

export function apiUpload(path: string, body: Uint8Array | Blob, method = 'PUT'): Promise<void> {
	return upload(accountCaller, path, body, method)
}
