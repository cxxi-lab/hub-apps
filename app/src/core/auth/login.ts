import { getApiBaseUrl } from '@core/api/baseUrl'

export type LoginResult =
	| { token: string; expiresAt: number }
	/** two-factor authentication on: answer the challenge with a code (`loginTwoFactor`) */
	| { twoFactor: true; challenge: string }

export async function login({ email, password }: { email: string; password: string }): Promise<LoginResult | null> {
	return post('/api/hub/auth/login_check', { email, password })
}

/**
 * The second step: a code from the authenticator app, or a recovery code. null: wrong code; 'expired':
 * the challenge is over (too many codes, too late), the password again.
 */
export async function loginTwoFactor(challenge: string, code: string): Promise<{ token: string; expiresAt: number } | 'expired' | null> {
	try {
		const response = await fetch(`${getApiBaseUrl()}/api/hub/auth/2fa`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ challenge, code })
		})
		if (response.ok) return await response.json()
		const body = await response.json().catch(() => null) as { error?: string } | null
		return body?.error === 'expired' ? 'expired' : null
	}
	catch (error) {
		console.error('[Login] network error:', error)
		return null
	}
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
	try {
		const response = await fetch(`${getApiBaseUrl()}${path}`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		})

		if (!response.ok) {
			const text = await response.text()
			console.warn('[Login] failed:', response.status, text)
			return null
		}

		return await response.json()
	}
	catch (error) {
		console.error('[Login] network error:', error)
		return null
	}
}
