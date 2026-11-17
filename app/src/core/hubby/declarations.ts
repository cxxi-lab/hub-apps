/**
 * What each hubby declares about itself in its hubby.json (its catalogue entry), that the app
 * acts on around it — the app's own sources name no hubby:
 *  - `capabilities`: the server capabilities only it uses (/api/cap/<capability>): their calls
 *    belong to it (its lock, core/privacy/locks.ts);
 *  - `formerly`: the ids it had (its values sealed under them are opened, then sealed again under
 *    its id: core/crypto/documents.ts);
 *  - `encryptAtRest`: its data kept on the device (local-first, core/sync/engine.ts) is encrypted
 *    there too, with the data key, not only on its way through the server.
 */

export interface HubbyDeclaration {
	id: string
	capabilities?: string[]
	formerly?: string[]
	encryptAtRest?: boolean
}

const capabilityHubbies = new Map<string, string>()
const atRest = new Set<string>()
const formerIds = new Map<string, string[]>()

/** Takes a loaded (or installed) hubby's declarations into account. */
export function declareHubby({ id, capabilities, encryptAtRest, formerly }: HubbyDeclaration): void {
	if (encryptAtRest === true) atRest.add(id)
	if (formerly?.length) formerIds.set(id, formerly.filter(f => typeof f === 'string' && f !== id))
	for (const capability of capabilities ?? []) {
		capabilityHubbies.set(capability, id)
	}
}

/** The ids a hubby had (`formerly`): its data sealed under them still opens, then moves to its id. */
export const formerlyOf = (hubby: string): string[] => formerIds.get(hubby) ?? []

/** Whether the hubby's data on this device is encrypted there (`encryptAtRest`). */
export const encryptsAtRest = (hubby: string): boolean => atRest.has(hubby)

/** The hubby a capability belongs to (the only one using it), if one declared it. */
export const hubbyOfCapability = (capability: string): string | null => capabilityHubbies.get(capability) ?? null

