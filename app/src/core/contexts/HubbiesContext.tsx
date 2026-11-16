import { createContext, useContext, useMemo } from 'react'
import type { Contribution, ContributionPoint } from '@core/hubby/contributions'
import type { HubbyManifest } from '@core/hubby/types'
import { hasScope, useHubbyScopes } from '@core/hubbies/scopes'

/** The hubbies active here (enabled, shown), in the user's order (the home page lists them). */
export const HubbiesContext = createContext<HubbyManifest[]>([])

export function useHubbies(): HubbyManifest[] {
	return useContext(HubbiesContext)
}

/** The scope a hubby needs to contribute to a point (the point's owner's feature). */
const POINT_SCOPES: Record<ContributionPoint, string> = {
	timeline: 'hubby:planner.timeline'
}

/**
 * What the active hubbies offer at a contribution point (none outside the main window): only
 * those the account allowed it (their `hubby:` scope).
 */
export function useContributions<P extends ContributionPoint>(point: P): Contribution<P>[] {
	const hubbies = useHubbies()
	const scopes = useHubbyScopes()
	return useMemo(
		() => hubbies.flatMap(m => {
			const value = m.contributes?.[point]
			if (value === undefined || !hasScope(scopes, m.id, POINT_SCOPES[point])) return []
			return [{ hubbyId: m.id, moduleId: m.id, value: value as Contribution<P>['value'] }]
		}),
		[hubbies, point, scopes]
	)
}
