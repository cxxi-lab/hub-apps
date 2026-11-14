import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { platform } from '@platform'

const DevModeContext = createContext<boolean>(false)

export function DevModeProvider({ children }: { children: ReactNode }) {
	const [devMode, setDevMode] = useState(false)

	useEffect(() => {
		platform.getDevMode().then(setDevMode)
		return platform.onDevModeChange(setDevMode)
	}, [])

	return <DevModeContext.Provider value={devMode}>{children}</DevModeContext.Provider>
}

export function useDevMode(): boolean {
	return useContext(DevModeContext)
}
