/**
 * What each hubby declares about itself in its hubby.json (its catalogue entry), that the app
 * acts on around it — the app's own sources name no hubby:
 *  - `capabilities`: the server capabilities only it uses (/api/cap/<capability>): their calls
 *    belong to it (its lock, core/privacy/locks.ts);
 *  - `formerly`: the ids it had (its values sealed under them are opened, then sealed again under
 *    its id: core/crypto/documents.ts);
 *  - `encryptAtRest`: its data kept on the device (local-first, core/sync/engine.ts) is encrypted
 *    there too, with the data key, not only on its way through the server;
 *  - `storageFrom`: the keys it kept in the app's localStorage before it had its own storage
 *    (core/hubby/storage.ts): copied into it once.
 */

export interface HubbyDeclaration {
	id: string
	capabilities?: string[]
	formerly?: string[]
	encryptAtRest?: boolean
	storageFrom?: string[]
}

const capabilityHubbies = new Map<string, string>()
const atRest = new Set<string>()
const formerIds = new Map<string, string[]>()
const storageFrom = new Map<string, string[]>()

/** Takes a loaded (or installed) hubby's declarations into account. */
export function declareHubby({ id, capabilities, encryptAtRest, formerly, storageFrom: legacyKeys }: HubbyDeclaration): void {
	if (encryptAtRest === true) atRest.add(id)
	if (Array.isArray(legacyKeys)) storageFrom.set(id, legacyKeys.filter(k => typeof k === 'string' && k !== ''))
	if (formerly?.length) formerIds.set(id, formerly.filter(f => typeof f === 'string' && f !== id))
	for (const capability of capabilities ?? []) {
		capabilityHubbies.set(capability, id)
	}
}

/** The ids a hubby had (`formerly`): its data sealed under them still opens, then moves to its id. */
export const formerlyOf = (hubby: string): string[] => formerIds.get(hubby) ?? []

/** The keys the hubby kept in the app's localStorage before (`storageFrom`). */
export const storageFromOf = (hubby: string): string[] => storageFrom.get(hubby) ?? []

/** Whether the hubby's data on this device is encrypted there (`encryptAtRest`). */
export const encryptsAtRest = (hubby: string): boolean => atRest.has(hubby)

/** The hubby a capability belongs to (the only one using it), if one declared it. */
export const hubbyOfCapability = (capability: string): string | null => capabilityHubbies.get(capability) ?? null

