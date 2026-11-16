import type { HubbiesState } from '@core/api/hubbies'
import { isComingSoon, isInstalled, HUBBY_INTEGRITY_ENFORCE, HUBBY_MANIFESTS } from '@core/hubby/registry'
import type { HubbyManifest } from '@core/hubby/types'
import { platform } from '@platform'

/**
 * Hubbies this account can have here: the shell hosts them, the server serves them, and they are
 * not hidden (Privacy) or revealed this session.
 */
function usable(state: HubbiesState, revealed: string[]): HubbyManifest[] {
	return HUBBY_MANIFESTS.filter(m => {
		if (m.requiresCapabilities?.some(c => !platform.capabilities[c])) return false
		if ((state.hidden ?? []).includes(m.id) && !revealed.includes(m.id)) return false
		if (!m.local && HUBBY_INTEGRITY_ENFORCE && state.available.length > 0 && !state.available.includes(m.id)) return false
		return true
	})
}

/** The enabled list as stored, spelled out when it is the default (every hubby with pages or to install, catalogue order). */
export function enabledIds(state: HubbiesState): string[] {
	return state.enabled ?? HUBBY_MANIFESTS.filter(m => !isComingSoon(m)).map(m => m.id)
}

/**
 * The hubbies shown here, in the user's order: the top bar, the home page and the routes. Hubbies
 * without pages yet, or not installed here yet, are not shown.
 */
export function enabledModules(state: HubbiesState, revealed: string[]): HubbyManifest[] {
	const byId = new Map(usable(state, revealed).filter(m => isInstalled(m) && !isComingSoon(m)).map(m => [m.id, m]))
	return withRequirements(enabledIds(state).flatMap(id => byId.get(id) ?? []))
}

/**
 * The enabled hubbies this device must have installed (ids), installed yet or not: an enabled
 * hubby is installed on every device that can run it. Ids not listed yet are in (the store may
 * not have answered).
 */
export function wantedIds(state: HubbiesState, revealed: string[]): string[] {
	const ids = new Set(usable(state, revealed).filter(m => !isComingSoon(m)).map(m => m.id))
	return enabledIds(state).filter(id => ids.has(id) || !HUBBY_MANIFESTS.some(m => m.id === id))
}

/**
 * Keeps the hubbies whose requirements (`requires`) are all in the list, until it no longer
 * changes: a hubby out takes the ones requiring it along.
 */
export function withRequirements(hubbies: HubbyManifest[]): HubbyManifest[] {
	let kept = hubbies
	for (;;) {
		const ids = new Set(kept.map(m => m.id))
		const next = kept.filter(m => (m.requires ?? []).every(id => ids.has(id)))
		if (next.length === kept.length) return kept
		kept = next
	}
}

/** The requirements of a hubby that are not active (ids): why it stays off. */
export function missingRequirements(hubby: HubbyManifest, active: HubbyManifest[]): string[] {
	const ids = new Set(active.map(m => m.id))
	return (hubby.requires ?? []).filter(id => !ids.has(id))
}

/** Every hubby of this shell for the Settings list (enabled or not), in catalogue order. */
export function allHubbies(state: HubbiesState, revealed: string[]): HubbyManifest[] {
	return usable(state, revealed)
}
