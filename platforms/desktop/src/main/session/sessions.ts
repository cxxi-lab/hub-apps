import { session } from 'electron'

/**
 * The webviews' sessions (server docs/plan-reseau-vpn.md, phase 4): each hubby's own,
 * `persist:hubby:<id>` (its sites' cookies and storage, its way out: through the VPN for a hubby
 * going out through it, else direct). `persist:browse`, the former session shared by every webview,
 * stays for the hubby bundles that still ask for it (through the VPN, as before).
 */
export const BROWSE_PARTITION = 'persist:browse'

const HUBBY_PARTITION = /^persist:hubby:([a-z0-9-]{1,80})$/

/** A hubby's webview partition. */
export const hubbyPartition = (hubby: string): string => `persist:hubby:${hubby}`

/** The partition a webview asked for, as allowed: a hubby's own, else the former shared one. */
export function webviewPartition(asked: string | undefined): string {
	return asked && HUBBY_PARTITION.test(asked) ? asked : BROWSE_PARTITION
}

/** The hubby of a webview partition (null: the former shared one). */
export function hubbyOfPartition(partition: string): string | null {
	return HUBBY_PARTITION.exec(partition)?.[1] ?? null
}

type WebSessionSetup = (sess: Electron.Session, partition: string) => void | Promise<void>

const known = new Map<string, Electron.Session>()
const setups: WebSessionSetup[] = []

/** Runs on every webview session, the ones known and the ones to come (proxy, blocklist, integrations). */
export function onWebSession(setup: WebSessionSetup): void {
	setups.push(setup)
	for (const [partition, sess] of known) void setup(sess, partition)
}

/** A webview session, set up the first time it is asked for. */
export function webSession(partition: string): Electron.Session {
	let sess = known.get(partition)
	if (!sess) {
		sess = session.fromPartition(partition)
		known.set(partition, sess)
		for (const setup of setups) void setup(sess, partition)
	}
	return sess
}

/** The webview sessions known now, with their partition. */
export function webviewSessions(): Array<[string, Electron.Session]> {
	return [...known.entries()]
}

/** The sessions whose requests the player blocklist (ads, trackers) filters, besides the webviews'. */
export function appSessions(): Electron.Session[] {
	return [session.defaultSession, session.fromPartition('persist:oauth')]
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

