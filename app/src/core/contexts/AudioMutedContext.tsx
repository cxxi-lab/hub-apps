import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { platform } from '@platform'

const AudioMutedContext = createContext<boolean>(true)

export function AudioMutedProvider({ children }: { children: ReactNode }) {
	const [muted, setMuted] = useState(true)

	useEffect(() => {
		platform.getMuted().then(setMuted)
		return platform.onMutedChange(setMuted)
	}, [])

	return <AudioMutedContext.Provider value={muted}>{children}</AudioMutedContext.Provider>
}

export function useAudioMuted(): boolean {
	return useContext(AudioMutedContext)
}
