import { useSyncExternalStore } from 'react'
import { headlessFrames } from './apis'
import { HubbyHost } from './HubbyHost'

/** The unseen frames of the hubbies answering their API's calls (apis.ts), in the app's layout. */
export function HubbyApiFrames() {
	const ids = useSyncExternalStore(headlessFrames.subscribe, headlessFrames.current)
	return <>{ids.map(id => <HubbyHost key={id} hubby={id} headless />)}</>
}
