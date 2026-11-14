import { getApiBaseUrl } from '@core/api/baseUrl'
import { CLIENT_HEADER } from '@shared/constants'
import { establishAuthState, resetAuthState, getAuthData, isAuthenticated } from './authState'

let refreshInProgress: { baseUrl: string; promise: Promise<boolean> } | null = null

async function refreshToken(baseUrl: string): Promise<{ token: string; expiresAt: number }> {
	const { token } = await getAuthData(baseUrl)

	if (!token) throw new Error('No token available for refresh')

	const response = await fetch(`${baseUrl}/api/hub/auth/token_refresh`, {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${token}`,
			...CLIENT_HEADER
		}
	})

	if (!response.ok) {
		const text = await response.text()
		throw new Error(`Refresh failed: ${response.status} - ${text}`)
	}

	const data = await response.json()

	if (!data?.token || !data?.expiresAt) {
		throw new Error('Refresh response missing token or expiresAt')
	}

	return data
}

export async function ensureValidToken(): Promise<void> {
	if (await isAuthenticated()) return
	await tryRefreshToken()
}

export async function tryRefreshToken(): Promise<boolean> {
	// Captured once so the whole refresh (request + storage) sticks to one server,
	// even if the target is toggled while it is in flight.
	const baseUrl = getApiBaseUrl()

	if (refreshInProgress?.baseUrl === baseUrl) return refreshInProgress.promise

	const promise = (async () => {
		try {
			const data = await refreshToken(baseUrl)
			await establishAuthState(data.token, data.expiresAt, baseUrl)
			return true
		}
		catch (err) {
			console.error('[Refresh] failed', err)
			await resetAuthState(baseUrl)
			return false
		}
		finally {
			if (refreshInProgress?.baseUrl === baseUrl) refreshInProgress = null
		}
	})()

	refreshInProgress = { baseUrl, promise }

	return promise
}
