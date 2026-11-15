import { api } from './client'

/** An account connected at a provider (Settings › Connections): what it serves, never its tokens. */
export interface Connection {
	id: string
	provider: string
	email: string
	name: string | null
	/** what it is allowed for: 'mail', 'drive'… */
	uses: string[]
	createdAt: string
	lastUsedAt: string | null
	lastError: string | null
}

export interface ConnectProvider {
	id: string
	label: string
	/** an OAuth client is set up on the server */
	configured: boolean
	uses: string[]
}

export function fetchConnections() {
	return api<{ data: { connections: Connection[]; providers: ConnectProvider[] } }>('/api/hub/connections').then(r => r.data)
}

export function removeConnection(id: string) {
	return api<{ ok: true }>(`/api/hub/connections/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** How a consent started from here ended. */
export type ConnectAttempt =
	| { status: 'pending' }
	| { status: 'connected'; connection: Connection | null }
	| { status: 'failed'; error: string }

const POLL_MS = 2000
/** the server forgets an attempt after 30 min */
const GIVE_UP_MS = 30 * 60 * 1000

/**
 * Connects an account for a use, or gives one already connected a use more (`connection`): the
 * provider's consent opens in the browser, the provider redirects to the server, which exchanges the
 * code; meanwhile the app asks how it ends. `signal`: stop waiting (the user cancelled).
 */
export async function connect(provider: string, use: string, connection?: string, signal?: AbortSignal): Promise<Connection | null> {
	const { url, attempt } = await api<{ data: { url: string; attempt: string } }>(`/api/hub/connections/${provider}/start`, {
		method: 'POST',
		body: JSON.stringify({ use, connection: connection ?? null }),
	}).then(r => r.data)
	// the system browser (desktop: the window-open handler; Android: outside the WebView)
	window.open(url, '_blank', 'noopener')

	const until = Date.now() + GIVE_UP_MS
	while (Date.now() < until) {
		await new Promise(resolve => setTimeout(resolve, POLL_MS))
		if (signal?.aborted) return null
		const state = await api<{ data: ConnectAttempt }>(`/api/hub/connections/attempts/${encodeURIComponent(attempt)}`).then(r => r.data)
		if (state.status === 'connected') return state.connection
		if (state.status === 'failed') throw new Error(state.error)
	}
	throw new Error('The connection took too long: start it again')
}
