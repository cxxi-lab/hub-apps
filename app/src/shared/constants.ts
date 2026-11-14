import { platform } from '@platform'

export const AUTH_STATES = {
	UNAUTHENTICATED: 'unauthenticated',
	AUTHENTICATED: 'authenticated'
} as const

export const STORE_KEY = {
	AUTH_STATE: 'auth_state',
	JWT_TOKEN: 'token',
	JWT_TOKEN_EXPIRES_AT: 'token_expires_at'
} as const

export const REFRESH = {
	MARGIN: 60000
} as const

// Required by the server on its cookie-authenticated auth routes (refresh,
// logout): a cross-site page can't forge it, which blocks CSRF. The value
// identifies the client (desktop vs android) and comes from the active platform
// adapter, so each build announces itself correctly.
export const CLIENT_HEADER: Record<'X-Hub-Client', string> = {
	'X-Hub-Client': platform.client
}
