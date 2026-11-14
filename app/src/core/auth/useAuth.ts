import { useEffect, useState } from 'react'
import { AUTH_STATES, STORE_KEY } from '@shared/constants'
import { get, onChange } from '@shared/store'
import { onBaseUrlChange } from '@core/api/baseUrl'
import { authKey } from './authState'

type AuthState = 'authenticated' | 'unauthenticated'

function compute(): AuthState {
	const token = get<string>(authKey(STORE_KEY.JWT_TOKEN))
	const state = get<string>(authKey(STORE_KEY.AUTH_STATE))
	return token && state === AUTH_STATES.AUTHENTICATED ? 'authenticated' : 'unauthenticated'
}

export function useAuth(): AuthState {
	const [state, setState] = useState<AuthState>(compute)

	useEffect(() => {
		const offStore = onChange(change => {
			if (change.key === authKey(STORE_KEY.JWT_TOKEN) || change.key === authKey(STORE_KEY.AUTH_STATE)) {
				setState(compute())
			}
		})
		const offBaseUrl = onBaseUrlChange(() => setState(compute()))

		return () => {
			offStore()
			offBaseUrl()
		}
	}, [])

	return state
}
