import { createContext, useContext, useMemo } from 'react'
import type { Contribution, ContributionPoint } from '@core/module/contributions'
import type { ModuleManifest } from '@core/module/types'
import { hasScope, useModuleScopes } from '@core/modules/scopes'

/** The modules active here (enabled, shown), in the user's order (the home page lists them). */
export const ModulesContext = createContext<ModuleManifest[]>([])

export function useModules(): ModuleManifest[] {
	return useContext(ModulesContext)
}

/** The scope a module needs to contribute to a point (the point's owner's feature). */
const POINT_SCOPES: Record<ContributionPoint, string> = {
	timeline: 'module:planner.timeline'
}

/**
 * What the active modules offer at a contribution point (none outside the main window): only
 * those the account allowed it (their `module:` scope).
 */
export function useContributions<P extends ContributionPoint>(point: P): Contribution<P>[] {
	const modules = useModules()
	const scopes = useModuleScopes()
	return useMemo(
		() => modules.flatMap(m => {
			const value = m.contributes?.[point]
			if (value === undefined || !hasScope(scopes, m.id, POINT_SCOPES[point])) return []
			return [{ moduleId: m.id, value: value as Contribution<P>['value'] }]
		}),
		[modules, point, scopes]
	)
}
