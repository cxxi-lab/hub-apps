import { serverIdentity } from '@core/api/baseUrl'
import { getAuthData } from '@core/auth/authState'

let accountKey: Promise<string> | null = null

/**
 * A stable key for the signed-in account on this server (a hash: no name on the disk): the
 * device's base (platform.localStore) is per account and server (its identity: serverIdentity, the
 * same across its renames).
 */
export function account(): Promise<string> {
	accountKey ??= (async () => {
		const { token } = await getAuthData()
		const payload = token ? JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))) as { username?: string } : {}
		const bytes = new TextEncoder().encode(`${serverIdentity()}|${payload.username ?? ''}`)
		const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
		return [...digest].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32)
	})()
	return accountKey
}
