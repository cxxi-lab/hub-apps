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

export async function api<T>(path: string, options: RequestInit = {}, retry = true): Promise<T> {
	const { token } = await getAuthData()

	// a FormData body (multipart): the browser sets the type, with its boundary
	const headers = {
		...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
		Accept: 'application/json',
		...options.headers,
		...unlockHeaders(path),
		...(token ? { Authorization: `Bearer ${token}` } : {})
	}

	const response = await fetch(`${getApiBaseUrl(path)}${path}`, { ...options, headers })

	if (response.status === 401) {
		if (retry) {
			const refreshed = await tryRefreshToken()
			if (!refreshed) {
				await resetAuthState()
				throw new Error('Unauthorized')
			}
			return api<T>(path, options, false)
		}
		await resetAuthState()
		throw new Error('Unauthorized')
	}

	if (response.status === 423) lockedByServer(path)

	if (!response.ok) {
		const body = await response.json().catch(() => null)
		throw new ApiError(response.status, typeof body?.detail === 'string' ? body.detail : null)
	}

	// 204: nothing to read
	if (response.status === 204) return undefined as T
	return response.json()
}

/**
 * Sends raw bytes (a file) with the session, like api(): PUT by default. For the stores' files.
 */
export async function apiUpload(path: string, body: Uint8Array | Blob, method = 'PUT'): Promise<void> {
	const { token } = await getAuthData()
	const response = await fetch(`${getApiBaseUrl(path)}${path}`, {
		method,
		body: body as BodyInit,
		headers: { 'Content-Type': 'application/octet-stream', ...unlockHeaders(path), ...(token ? { Authorization: `Bearer ${token}` } : {}) }
	})
	if (response.status === 423) lockedByServer(path)
	if (!response.ok) throw new ApiError(response.status, null)
}
