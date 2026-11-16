/**
 * What each module declares about itself in its module.json (its catalogue entry), that the app
 * acts on around it — the app's own sources name no module:
 *  - `capabilities`: the server capabilities only it uses (/api/cap/<capability>): their calls
 *    belong to it (its lock, core/privacy/locks.ts);
 *  - `network: "vpn"`: its data and those capabilities are reached under the VPN-only name
 *    (core/api/baseUrl.ts), the server refusing them from elsewhere;
 *  - `formerly`: the ids it had (its values sealed under them are opened, then sealed again under
 *    its id: core/crypto/documents.ts);
 *  - `encryptAtRest`: its data kept on the device (local-first, core/sync/engine.ts) is encrypted
 *    there too, with the data key, not only on its way through the server.
 */

export interface ModuleDeclaration {
	id: string
	capabilities?: string[]
	network?: 'vpn'
	formerly?: string[]
	encryptAtRest?: boolean
}

const capabilityModules = new Map<string, string>()
const vpnModules = new Set<string>()
const vpnCapabilities = new Set<string>()
const atRest = new Set<string>()
const formerIds = new Map<string, string[]>()

/** Takes a loaded (or installed) module's declarations into account. */
export function declareModule({ id, capabilities, network, encryptAtRest, formerly }: ModuleDeclaration): void {
	if (encryptAtRest === true) atRest.add(id)
	if (formerly?.length) formerIds.set(id, formerly.filter(f => typeof f === 'string' && f !== id))
	for (const capability of capabilities ?? []) {
		capabilityModules.set(capability, id)
		if (network === 'vpn') vpnCapabilities.add(capability)
	}
	if (network === 'vpn') vpnModules.add(id)
}

/** The ids a module had (`formerly`): its data sealed under them still opens, then moves to its id. */
export const formerlyOf = (module: string): string[] => formerIds.get(module) ?? []

/** Whether the module's data on this device is encrypted there (`encryptAtRest`). */
export const encryptsAtRest = (module: string): boolean => atRest.has(module)

/** The module a capability belongs to (the only one using it), if one declared it. */
export const moduleOfCapability = (capability: string): string | null => capabilityModules.get(capability) ?? null

/**
 * Whether an API path is reached under the VPN-only name: a VPN module's data, a capability it
 * declared, and the media the scrape capability serves (/media/…) when one declared it.
 */
export function isVpnPath(path: string): boolean {
	const data = /^\/api\/data\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (data) return vpnModules.has(data[1])
	const capability = /^\/api\/cap\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (capability) return vpnCapabilities.has(capability[1])
	return path.startsWith('/media/') && vpnCapabilities.has('scrape')
}
