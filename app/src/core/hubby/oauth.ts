import { ApiError, type ApiCall } from '@core/api/client'

/**
 * The account's connections at a provider (Google, Microsoft), as a hubby uses them (server
 * docs/plan-oauth.md): the hubby declares the provider scopes it needs (hubby.json `oauth`), the
 * account allows it the provider (`app:oauth:<provider>`, its permissions), then it lists the
 * connections, connects an account (the consent opens in the browser, the server takes the
 * provider's answer) and gets access tokens narrowed to its scopes. Every call is the hubby's
 * (its token): the SDK binds it (src/sdk/index.ts), the host too for an isolated one.
 */

/** An account connected at a provider, as the hubby sees it. */
export interface OAuthConnection {
	id: string
	provider: string
	email: string
	name: string | null
	/** its grant covers what the hubby declares (else: connect it again, `connect(provider, { connection })`) */
	ready: boolean
	lastError: string | null
}

export interface OAuthAccessToken {
	accessToken: string
	/** unix seconds */
	expiresAt: number
}

export interface OAuthApi {
	/** The account's connections at the providers the hubby declares (and was allowed). */
	connections(): Promise<OAuthConnection[]>
	/**
	 * Connects an account at a provider for what the hubby declares, or gives one connected
	 * (`connection`) what it lacks: the consent opens in the browser; resolves once the account
	 * consented (null: given up, `signal`).
	 */
	connect(provider: string, options?: { connection?: string, signal?: AbortSignal }): Promise<OAuthConnection | null>
	/** An access token of a connection, for the hubby's scopes (kept until shortly before it expires). */
	accessToken(connection: string): Promise<OAuthAccessToken>
}

const POLL_MS = 2000
/** the server forgets an attempt after 30 min */
const GIVE_UP_MS = 30 * 60 * 1000
/** a token this close to its expiry is asked again */
const MARGIN_S = 60

type Attempt =
	| { status: 'pending' }
	| { status: 'connected', connection: OAuthConnection | null }
	| { status: 'failed', error: string }

/** A 403 of the capability: the hubby declares no use of the provider, or was not allowed it. */
function explained(err: unknown): unknown {
	if (err instanceof ApiError && err.status === 403 && err.detail) {
		return new Error(`${err.detail} (its settings › Permissions)`)
	}
	return err
}

export function createOAuth(call: ApiCall): OAuthApi {
	const tokens = new Map<string, OAuthAccessToken>()

	return {
		connections: () => call<{ data: OAuthConnection[] }>('/api/cap/oauth/connections').then(r => r.data),

		async connect(provider, { connection, signal } = {}) {
			const { url, attempt } = await call<{ data: { url: string, attempt: string } }>(`/api/cap/oauth/${encodeURIComponent(provider)}/start`, {
				method: 'POST',
				body: JSON.stringify({ connection: connection ?? null }),
			}).then(r => r.data, err => { throw explained(err) })
			// the system browser (desktop: the window-open handler; Android: outside the WebView)
			window.open(url, '_blank', 'noopener')

			const until = Date.now() + GIVE_UP_MS
			while (Date.now() < until) {
				await new Promise(resolve => setTimeout(resolve, POLL_MS))
				if (signal?.aborted) return null
				const state = await call<{ data: Attempt }>(`/api/cap/oauth/attempts/${encodeURIComponent(attempt)}`).then(r => r.data)
				if (state.status === 'connected') {
					if (state.connection) tokens.delete(state.connection.id)
					return state.connection
				}
				if (state.status === 'failed') throw new Error(state.error)
			}
			throw new Error('The connection took too long: start it again')
		},

		async accessToken(connection) {
			const held = tokens.get(connection)
			if (held && held.expiresAt - MARGIN_S > Date.now() / 1000) return held
			const fresh = await call<{ data: OAuthAccessToken }>(`/api/cap/oauth/connections/${encodeURIComponent(connection)}/token`, { method: 'POST' })
				.then(r => r.data, err => { throw explained(err) })
			tokens.set(connection, fresh)
			return fresh
		},
	}
}
