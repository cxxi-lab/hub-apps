import { getApiBaseUrl } from '@core/api/baseUrl'
import { CLIENT_HEADER } from '@shared/constants'
import { getAuthData } from './authState'
import { forgetPushDevice } from '@core/notifications/push'
import { resetDataKey } from '@core/crypto/dataKey'

export async function logout(): Promise<unknown | null> {
	// while still signed in: this device stops getting the notifications
	await forgetPushDevice()
	resetDataKey()
	try {
		// Sending the access token lets the server revoke it, not just the refresh cookie.
		const { token } = await getAuthData()
		const response = await fetch(`${getApiBaseUrl()}/api/hub/auth/logout`, {
			method: 'POST',
			credentials: 'include',
			headers: {
				'Content-Type': 'application/json',
				...CLIENT_HEADER,
				...(token ? { Authorization: `Bearer ${token}` } : {})
			}
		})

		if (!response.ok) {
			const text = await response.text()
			console.warn('[Logout] failed:', response.status, text)
			return null
		}

		if (response.status === 204) return {}

		return await response.json()
	}
	catch (error) {
		console.error('[Logout] network error:', error)
		return null
	}
}
