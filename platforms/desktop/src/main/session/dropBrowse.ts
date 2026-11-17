import { app } from 'electron'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'

/**
 * The former webview session shared by every hubby (persist:browse) is gone (server
 * docs/plan-reseau-vpn.md, phase 4): its cookies were copied into each VPN hubby's own session
 * (v0.114.0). Its files are removed at start, before any session exists.
 */
export function dropBrowseSession(): void {
	const dir = path.join(app.getPath('userData'), 'Partitions', 'browse')
	if (!existsSync(dir)) return
	try {
		rmSync(dir, { recursive: true, force: true })
		console.log('[sessions] the former shared webview session removed')
	}
	catch (err) {
		console.warn('[sessions] could not remove the former shared webview session', err)
	}
}
