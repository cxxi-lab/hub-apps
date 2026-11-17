import { api, request, upload, type Caller } from '@core/api/client'
import { stream, type StreamEventHandler } from '@core/api/stream'
import { getAuthData } from '@core/auth/authState'
import { lock, UNLOCK_HEADER, unlockHeadersOf } from '@core/privacy/locks'

/**
 * The hubbies' tokens (server docs/plan-identite-hubbies.md): each hubby's calls carry its own,
 * so the server knows which hubby makes each one, and lets it reach its data and the
 * capabilities it declares only. Asked with the account's token (POST /api/hub/hubbies/<id>/token),
 * kept here in memory until shortly before it runs out; a locked hubby's carries its unlock, so
 * it is asked again when that changes, and so is one of another session (signed out, or in as
 * another account: the account token's `sid`). What the hubby may do is never in it: the server reads its
 * scopes, enabling and lock at each call.
 */

interface Held { token: string, expires: number, unlock: string | null, session: string | null }

const held = new Map<string, Held>()
const asking = new Map<string, Promise<Held>>()
/** asked again this long before it runs out */
const MARGIN = 60_000

/** The session of the account's token (its `sid`), null without one. */
async function session(): Promise<string | null> {
	const { token } = await getAuthData()
	if (!token) return null
	try {
		const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { sid?: unknown }
		return typeof payload.sid === 'string' ? payload.sid : null
	}
	catch {
		return null
	}
}

function ask(hubby: string, unlock: string | null, sid: string | null): Promise<Held> {
	const key = `${hubby}\n${unlock ?? ''}\n${sid ?? ''}`
	let pending = asking.get(key)
	if (!pending) {
		pending = api<{ data: { token: string, expiresAt: number } }>(`/api/hub/hubbies/${encodeURIComponent(hubby)}/token`, {
			method: 'POST',
			headers: unlock ? unlockHeadersOf(hubby) : {}
		})
			.then(({ data }) => {
				const fresh = { token: data.token, expires: data.expiresAt * 1000 - MARGIN, unlock, session: sid }
				held.set(hubby, fresh)
				return fresh
			})
			.finally(() => asking.delete(key))
		asking.set(key, pending)
	}
	return pending
}

/** The hubby's token (asked when it has none, or one about to run out or for another unlock). */
export async function hubbyToken(hubby: string): Promise<string> {
	const unlock = unlockHeadersOf(hubby)[UNLOCK_HEADER] ?? null
	const sid = await session()
	const current = held.get(hubby)
	if (current && current.expires > Date.now() && current.unlock === unlock && current.session === sid) return current.token
	return (await ask(hubby, unlock, sid)).token
}

export function forgetHubbyToken(hubby: string): void {
	held.delete(hubby)
}

/** Calls made as the hubby: with its token. */
export function hubbyCaller(hubby: string): Caller {
	return {
		hubby,
		async headers() {
			return { Authorization: `Bearer ${await hubbyToken(hubby)}` }
		},
		async unauthorized() {
			// run out, or its session ended: a new one (asked with the account's, refreshed if need be)
			forgetHubbyToken(hubby)
			return true
		},
		locked() {
			forgetHubbyToken(hubby)
			lock(hubby)
		}
	}
}

/** The API as a hubby: what the SDK gives the hubby, what the host uses for an isolated one. */
export interface HubbyApi {
	api<T>(path: string, options?: RequestInit, retry?: boolean): Promise<T>
	apiStream(path: string, options: RequestInit, onEvent: StreamEventHandler, retry?: boolean): Promise<void>
	apiUpload(path: string, body: Uint8Array | Blob, method?: string): Promise<void>
}

const apis = new Map<string, HubbyApi>()

export function hubbyApi(hubby: string): HubbyApi {
	let bound = apis.get(hubby)
	if (!bound) {
		const caller = hubbyCaller(hubby)
		bound = {
			api: (path, options, retry) => request(caller, path, options, retry),
			apiStream: (path, options, onEvent, retry) => stream(caller, path, options, onEvent, retry),
			apiUpload: (path, body, method) => upload(caller, path, body, method)
		}
		apis.set(hubby, bound)
	}
	return bound
}
