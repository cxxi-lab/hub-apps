import { createContext, useContext } from 'react'
import type { HubbyManifest } from '@core/hubby/types'

/** The hubbies active here (enabled, shown), in the user's order (the home page lists them). */
export const HubbiesContext = createContext<HubbyManifest[]>([])

export function useHubbies(): HubbyManifest[] {
	return useContext(HubbiesContext)
}
