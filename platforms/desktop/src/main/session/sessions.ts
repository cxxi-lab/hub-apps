import { session } from 'electron'

/** The embedded browser and players (Private's sites): entirely through the VPN. */
export const BROWSE_PARTITION = 'persist:browse'

/**
 * The name of the server only reachable through the VPN: Private's API and media (the app's
 * VITE_SERVER_URL_PRIVATE). The app's own session sends only this name through the tunnel.
 */
export const PRIVATE_HOST = 'vpn.cxxi.io'

/** The sessions whose requests the player blocklist (ads, trackers) filters. */
export function webSessions(): Electron.Session[] {
	return [session.defaultSession, session.fromPartition(BROWSE_PARTITION), session.fromPartition('persist:oauth')]
}

const cspStrippedSessions = new WeakSet<Electron.Session>()

export function stripTrustedTypesCsp(sess: Electron.Session): void {
	if (cspStrippedSessions.has(sess)) return
	cspStrippedSessions.add(sess)
	sess.webRequest.onHeadersReceived((details, callback) => {
		const headers = details.responseHeaders ?? {}
		for (const key of Object.keys(headers)) {
			if (!/^content-security-policy(-report-only)?$/i.test(key)) continue
			headers[key] = (headers[key] as string[]).map(v =>
				v.replace(/require-trusted-types-for[^;]*;?/gi, '')
				 .replace(/trusted-types[^;]*;?/gi, '')
			)
		}
		callback({ responseHeaders: headers })
	})
}

/**
 * Writes the refresh-token cookie to disk as soon as the server rotates it.
 * Chromium flushes its cookie store lazily, so an app killed rather than quit
 * (every restart of `electron-vite dev`, a crash) would come back with the
 * previous token, already revoked by the rotation: a 401 and a forced re-login.
 */
export function persistRefreshCookie(): void {
	const cookies = session.defaultSession.cookies
	cookies.on('changed', (_event, cookie) => {
		if (cookie.name === 'refresh_token') void cookies.flushStore()
	})
}

/**
 * The server is now hubbyware.cxxi.io: the refresh-token cookie of its former name (hub.cxxi.io,
 * host-only) carried over once, so the update keeps the session. To remove with the former name
 * (docs/plan-renommage-hubbyware.md, layer 5).
 */
export async function carryRefreshCookie(): Promise<void> {
	const FORMER = 'https://hub.cxxi.io/api/hub/auth', CURRENT = 'https://hubbyware.cxxi.io/api/hub/auth'
	const cookies = session.defaultSession.cookies
	try {
		if ((await cookies.get({ url: CURRENT, name: 'refresh_token' })).length > 0) return
		const [former] = await cookies.get({ url: FORMER, name: 'refresh_token' })
		if (!former) return
		await cookies.set({
			url: CURRENT, name: former.name, value: former.value, path: former.path ?? '/api/hub/auth',
			secure: true, httpOnly: true, sameSite: 'no_restriction', expirationDate: former.expirationDate
		})
		await cookies.flushStore()
	} catch (error) {
		console.warn('[session] the former session could not be carried over', error)
	}
}
