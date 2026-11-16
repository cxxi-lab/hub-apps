/**
 * What each hubby declares about itself in its hubby.json (its catalogue entry), that the app
 * acts on around it — the app's own sources name no hubby:
 *  - `capabilities`: the server capabilities only it uses (/api/cap/<capability>): their calls
 *    belong to it (its lock, core/privacy/locks.ts);
 *  - `network: "vpn"`: its data and those capabilities are reached under the VPN-only name
 *    (core/api/baseUrl.ts), the server refusing them from elsewhere;
 *  - `formerly`: the ids it had (its values sealed under them are opened, then sealed again under
 *    its id: core/crypto/documents.ts);
 *  - `encryptAtRest`: its data kept on the device (local-first, core/sync/engine.ts) is encrypted
 *    there too, with the data key, not only on its way through the server.
 */

export interface HubbyDeclaration {
	id: string
	capabilities?: string[]
	network?: 'vpn'
	formerly?: string[]
	encryptAtRest?: boolean
}

const capabilityHubbies = new Map<string, string>()
const vpnHubbies = new Set<string>()
const vpnCapabilities = new Set<string>()
const atRest = new Set<string>()
const formerIds = new Map<string, string[]>()

/** Takes a loaded (or installed) hubby's declarations into account. */
export function declareHubby({ id, capabilities, network, encryptAtRest, formerly }: HubbyDeclaration): void {
	if (encryptAtRest === true) atRest.add(id)
	if (formerly?.length) formerIds.set(id, formerly.filter(f => typeof f === 'string' && f !== id))
	for (const capability of capabilities ?? []) {
		capabilityHubbies.set(capability, id)
		if (network === 'vpn') vpnCapabilities.add(capability)
	}
	if (network === 'vpn') vpnHubbies.add(id)
}

/** The ids a hubby had (`formerly`): its data sealed under them still opens, then moves to its id. */
export const formerlyOf = (hubby: string): string[] => formerIds.get(hubby) ?? []

/** Whether the hubby's data on this device is encrypted there (`encryptAtRest`). */
export const encryptsAtRest = (hubby: string): boolean => atRest.has(hubby)

/** The hubby a capability belongs to (the only one using it), if one declared it. */
export const hubbyOfCapability = (capability: string): string | null => capabilityHubbies.get(capability) ?? null

/**
 * Whether an API path is reached under the VPN-only name: a VPN hubby's data, a capability it
 * declared, and the media the scrape capability serves (/media/…) when one declared it.
 */
export function isVpnPath(path: string): boolean {
	const data = /^\/api\/data\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (data) return vpnHubbies.has(data[1])
	const capability = /^\/api\/cap\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (capability) return vpnCapabilities.has(capability[1])
	return path.startsWith('/media/') && vpnCapabilities.has('scrape')
}
