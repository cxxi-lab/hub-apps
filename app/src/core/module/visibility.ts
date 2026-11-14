import type { ModulesState } from '@core/api/modules'
import { isComingSoon, isInstalled, MODULE_INTEGRITY_ENFORCE, MODULE_MANIFESTS } from '@core/module/registry'
import type { ModuleManifest } from '@core/module/types'
import { platform } from '@platform'

/**
 * Modules this account can have here: the shell hosts them, the server serves them, and they are
 * not hidden (Privacy) or revealed this session.
 */
function usable(state: ModulesState, revealed: string[]): ModuleManifest[] {
	return MODULE_MANIFESTS.filter(m => {
		if (m.requiresCapabilities?.some(c => !platform.capabilities[c])) return false
		if ((state.hidden ?? []).includes(m.id) && !revealed.includes(m.id)) return false
		if (!m.local && MODULE_INTEGRITY_ENFORCE && state.available.length > 0 && !state.available.includes(m.id)) return false
		return true
	})
}

/** The enabled list as stored, spelled out when it is the default (every module with pages or to install, catalogue order). */
export function enabledIds(state: ModulesState): string[] {
	return state.enabled ?? MODULE_MANIFESTS.filter(m => !isComingSoon(m)).map(m => m.id)
}

/**
 * The modules shown here, in the user's order: the top bar, the home page and the routes. Modules
 * without pages yet, or not installed here yet, are not shown.
 */
export function enabledModules(state: ModulesState, revealed: string[]): ModuleManifest[] {
	const byId = new Map(usable(state, revealed).filter(m => isInstalled(m) && !isComingSoon(m)).map(m => [m.id, m]))
	return withRequirements(enabledIds(state).flatMap(id => byId.get(id) ?? []))
}

/**
 * The enabled modules this device must have installed (ids), installed yet or not: an enabled
 * module is installed on every device that can run it. Ids not listed yet are in (the store may
 * not have answered).
 */
export function wantedIds(state: ModulesState, revealed: string[]): string[] {
	const ids = new Set(usable(state, revealed).filter(m => !isComingSoon(m)).map(m => m.id))
	return enabledIds(state).filter(id => ids.has(id) || !MODULE_MANIFESTS.some(m => m.id === id))
}

/**
 * Keeps the modules whose requirements (`requires`) are all in the list, until it no longer
 * changes: a module out takes the ones requiring it along.
 */
export function withRequirements(modules: ModuleManifest[]): ModuleManifest[] {
	let kept = modules
	for (;;) {
		const ids = new Set(kept.map(m => m.id))
		const next = kept.filter(m => (m.requires ?? []).every(id => ids.has(id)))
		if (next.length === kept.length) return kept
		kept = next
	}
}

/** The requirements of a module that are not active (ids): why it stays off. */
export function missingRequirements(module: ModuleManifest, active: ModuleManifest[]): string[] {
	const ids = new Set(active.map(m => m.id))
	return (module.requires ?? []).filter(id => !ids.has(id))
}

/** Every module of this shell for the Settings list (enabled or not), in catalogue order. */
export function allModules(state: ModulesState, revealed: string[]): ModuleManifest[] {
	return usable(state, revealed)
}
