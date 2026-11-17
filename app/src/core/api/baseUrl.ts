import { CONFIG } from '@core/config'
import { platform } from '@platform'
import { isVpnPath } from '@core/hubby/declarations'

let currentDevMode = false
const listeners = new Set<(baseUrl: string) => void>()

export async function initBaseUrl(): Promise<void> {
	const value = await platform.getDevMode()
	currentDevMode = value
	console.log(`[api] base URL: ${getApiBaseUrl()} (dev mode: ${value})`)
	platform.onDevModeChange(next => {
		currentDevMode = next
		console.log(`[api] base URL: ${getApiBaseUrl()} (dev mode: ${next})`)
		for (const listener of listeners) listener(getApiBaseUrl())
	})
}

/**
 * The server's base URL. Given the path called and the hubby calling, the calls of a hubby
 * requiring the VPN (as it declares, core/hubby/declarations.ts) go to the name only reachable
 * through it (prod): the desktop routes that name through the tunnel, the phone routes everything
 * through it while it runs. Development: one local server.
 */
export function getApiBaseUrl(path?: string, hubby?: string | null): string {
	if (currentDevMode) return CONFIG.SERVER_URL_DEV
	return path && isVpnPath(path, hubby) ? CONFIG.SERVER_URL_PRIVATE_PROD : CONFIG.SERVER_URL_PROD
}

// Fires after the base URL has switched, so listeners already read the new target.
export function onBaseUrlChange(listener: (baseUrl: string) => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/**
 * The server's identity in what the device keeps per server (its tokens, its base: authKey, account):
 * a server's former name, so a rename keeps them. hubbyware.cxxi.io was hub.cxxi.io.
 */
const FORMER_NAMES: Record<string, string> = { 'https://hubbyware.cxxi.io': 'https://hub.cxxi.io' }

export function serverIdentity(baseUrl: string = getApiBaseUrl()): string {
	return FORMER_NAMES[baseUrl] ?? baseUrl
}
