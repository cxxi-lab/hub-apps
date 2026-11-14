import { AUTH_STATES, STORE_KEY, REFRESH } from '@shared/constants'
import { get, set, remove } from '@shared/store'
import { getApiBaseUrl, onBaseUrlChange } from '@core/api/baseUrl'
import { platform } from '@platform'
import { tryRefreshToken } from './refresh'

let refreshTimeoutId: ReturnType<typeof setTimeout> | null = null

// Auth data is stored per server so a token issued by one target (local / prod)
// is never sent to the other one.
export function authKey(key: string, baseUrl: string = getApiBaseUrl()): string {
	return `${key}@${baseUrl}`
}

function scheduleRefresh(expiresAt: number): void {
	clearScheduledRefresh()
	const delayMs = Math.max(0, expiresAt - Date.now() - REFRESH.MARGIN)
	refreshTimeoutId = setTimeout(() => { tryRefreshToken() }, delayMs)
	console.log(`[AuthState] Refresh scheduled in ${Math.round(delayMs / 1000)}s`)
}

function clearScheduledRefresh(): void {
	if (refreshTimeoutId !== null) {
		clearTimeout(refreshTimeoutId)
		refreshTimeoutId = null
	}
}

export async function establishAuthState(token: string, expiresAt: number, baseUrl: string = getApiBaseUrl()): Promise<void> {
	if (!token) throw new Error('No token provided for establishAuthState')
	if (!expiresAt) throw new Error('No expiresAt provided for establishAuthState')

	set(authKey(STORE_KEY.JWT_TOKEN, baseUrl), token)
	set(authKey(STORE_KEY.JWT_TOKEN_EXPIRES_AT, baseUrl), expiresAt)
	set(authKey(STORE_KEY.AUTH_STATE, baseUrl), AUTH_STATES.AUTHENTICATED)
	// Called right after the login / refresh response: its new refresh cookie must survive an app kill.
	platform.persistSession()

	// A refresh that resolves after a target switch must not reschedule for the old server.
	if (baseUrl === getApiBaseUrl()) scheduleRefresh(expiresAt)
}

export async function resetAuthState(baseUrl: string = getApiBaseUrl()): Promise<void> {
	remove(authKey(STORE_KEY.JWT_TOKEN, baseUrl))
	remove(authKey(STORE_KEY.JWT_TOKEN_EXPIRES_AT, baseUrl))
	if (baseUrl === getApiBaseUrl()) clearScheduledRefresh()
	set(authKey(STORE_KEY.AUTH_STATE, baseUrl), AUTH_STATES.UNAUTHENTICATED)
}

export async function getAuthData(baseUrl: string = getApiBaseUrl()): Promise<{ token: string | null; expiresAt: number | null }> {
	return {
		token: get<string>(authKey(STORE_KEY.JWT_TOKEN, baseUrl)),
		expiresAt: get<number>(authKey(STORE_KEY.JWT_TOKEN_EXPIRES_AT, baseUrl))
	}
}

export async function isAuthenticated(): Promise<boolean> {
	const { token, expiresAt } = await getAuthData()
	if (!token || !expiresAt) return false
	return Date.now() < expiresAt - REFRESH.MARGIN
}

async function resumeAuth(): Promise<void> {
	clearScheduledRefresh()

	const { token, expiresAt } = await getAuthData()
	if (!token || !expiresAt) return

	if (Date.now() >= expiresAt - REFRESH.MARGIN) {
		await tryRefreshToken()
	} else {
		scheduleRefresh(expiresAt)
	}
}

export async function bootAuth(): Promise<void> {
	// Pre-scoping keys: the token they hold has no known target, drop it.
	for (const key of Object.values(STORE_KEY)) localStorage.removeItem(key)

	onBaseUrlChange(() => { resumeAuth() })
	await resumeAuth()
}
