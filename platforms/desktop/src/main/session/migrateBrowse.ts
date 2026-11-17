import { app, session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { isVpnHubby } from '../network/vpnConfig'
import { BROWSE_PARTITION, hubbyOfPartition, onWebSession } from './sessions'

/**
 * Once per hubby going out through the VPN: the cookies of the former shared webview session
 * (persist:browse, where its sites were signed in) copied into its own (server
 * docs/plan-reseau-vpn.md, phase 4). The sites' local storage isn't carried over.
 */
const marker = (hubby: string): string => path.join(app.getPath('userData'), 'migrations', `browse-cookies-${hubby}`)

async function copyCookies(target: Electron.Session, hubby: string): Promise<void> {
	if (existsSync(marker(hubby))) return
	const cookies = await session.fromPartition(BROWSE_PARTITION).cookies.get({})
	let copied = 0
	for (const c of cookies) {
		const host = c.domain?.replace(/^\./, '')
		if (!host) continue
		try {
			await target.cookies.set({
				url: `${c.secure ? 'https' : 'http'}://${host}${c.path ?? '/'}`,
				name: c.name,
				value: c.value,
				...(c.domain?.startsWith('.') ? { domain: c.domain } : {}),
				path: c.path,
				secure: c.secure,
				httpOnly: c.httpOnly,
				...(c.expirationDate ? { expirationDate: c.expirationDate } : {}),
				...(c.sameSite ? { sameSite: c.sameSite } : {}),
			})
			copied++
		}
		catch {
			// a cookie the session refuses (its attributes): left behind
		}
	}
	mkdirSync(path.dirname(marker(hubby)), { recursive: true })
	writeFileSync(marker(hubby), `${new Date().toISOString()} ${copied}/${cookies.length}\n`)
	console.log(`[sessions] ${copied} cookies of the former shared session copied to ${hubby}'s`)
}

export function setupBrowseMigration(): void {
	onWebSession((sess, partition) => {
		const hubby = hubbyOfPartition(partition)
		if (hubby && isVpnHubby(hubby)) return copyCookies(sess, hubby).catch(err => console.warn('[sessions] cookie copy failed', err))
	})
}
