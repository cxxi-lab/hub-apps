import { getApiBaseUrl } from './baseUrl'
import { lockedByServer, unlockHeaders } from '@core/privacy/locks'
import { getAuthData, resetAuthState } from '@core/auth/authState'
import { tryRefreshToken } from '@core/auth/refresh'

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

/**
 * Sends a call to the API, as the account or a hubby, and gives its response when it succeeded
 * (2xx): a 401 renews the credentials once, a 423 locks the hubby, anything else not 2xx is an
 * ApiError.
 */
export async function send(caller: Caller, path: string, options: RequestInit = {}, retry = true): Promise<Response> {
	// a FormData body (multipart): the browser sets the type, with its boundary
	const headers = {
		...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
		Accept: 'application/json',
		...options.headers,
		...await caller.headers(path)
	}

	const response = await fetch(`${getApiBaseUrl()}${path}`, { ...options, headers })

	if (response.status === 401) {
		if (retry && await caller.unauthorized()) return send(caller, path, options, false)
		if (retry === false && caller === accountCaller) await resetAuthState()
		throw new Error('Unauthorized')
	}

	if (response.status === 423) caller.locked(path)

	if (!response.ok) throw await apiError(response)
	return response
}

/** The ApiError of a response not 2xx: its problem+json `detail`, or its JSON `error`. */
export async function apiError(response: Response): Promise<ApiError> {
	const body = await response.json().catch(() => null) as { detail?: unknown, error?: unknown } | null
	const detail = typeof body?.detail === 'string' ? body.detail : typeof body?.error === 'string' ? body.error : null
	return new ApiError(response.status, detail)
}

/**
 * A call to the API, as the account or a hubby: its JSON (nothing on a 204), an ApiError otherwise.
 * An operation that runs as a task even when called in sync (server docs/plan-tasks.md, D1)
 * answers 202 with its task: the call then waits for it, and gives the response the task got, as
 * if the call had lasted.
 */
export async function request<T>(caller: Caller, path: string, options: RequestInit = {}, retry = true): Promise<T> {
	const response = await send(caller, path, options, retry)
	const task = taskOf(response)
	if (task) return (await import('./tasks')).awaitTask<T>(caller, task)
	return read<T>(response)
}

/** A response's JSON (nothing on a 204). */
export async function read<T>(response: Response): Promise<T> {
	if (response.status === 204) return undefined as T
	return response.json()
}

/** The task a 202 answers with (its id), when the call was queued as a task (server: TaskableListener). */
export function taskOf(response: Response): string | null {
	if (response.status !== 202) return null
	return response.headers.get('Location')?.match(/^\/api\/cap\/tasks\/([0-9a-f]{24})$/)?.[1] ?? null
}

/** A call to the API as someone (the account, a hubby: the host binds each hubby's, core/hubby/tokens.ts). */
export type ApiCall = <T>(path: string, options?: RequestInit) => Promise<T>

/** A call as the account (the app itself). */
export function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
	return request<T>(accountCaller, path, options, retry)
}

/**
 * Sends raw bytes (a file), like api(): PUT by default. For the stores' files.
 */
export async function upload(caller: Caller, path: string, body: Uint8Array | Blob, method = 'PUT'): Promise<void> {
	const response = await fetch(`${getApiBaseUrl()}${path}`, {
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
