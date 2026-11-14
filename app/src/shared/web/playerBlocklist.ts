import { platform } from '@platform'
import { fetchPlayerBlocklist } from './players'

let synced: Promise<void> | null = null

/**
 * Makes sure the shell holds the back's current player blocklist before a
 * player loads a site: once per session, a 304 when nothing changed. A failure
 * leaves the shell's previous list in place and is retried next time.
 */
export function syncPlayerBlocklist(): Promise<void> {
	if (!synced) {
		synced = (async () => {
			const current = await platform.getPlayerBlocklistVersion()
			const list = await fetchPlayerBlocklist(current)
			if (list) await platform.setPlayerBlocklist(list.version, list.hosts)
		})().catch(err => {
			console.warn('[player] blocklist sync failed', err)
			synced = null
		})
	}
	return synced
}
