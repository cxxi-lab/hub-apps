import { useEffect, type ReactNode } from 'react'
import { useAuth } from '@core/auth/useAuth'
import { LoginForm } from './LoginForm'
import { platform } from '@platform'
import { DataKeyNotice } from '@core/crypto/DataKeyNotice'

export function AuthGate({ children }: { children: ReactNode }) {
	const auth = useAuth()

	useEffect(() => {
		platform.notifyAuthState(auth === 'authenticated')
	}, [auth])

	if (auth === 'unauthenticated') return <LoginForm />

	return <>{children}<DataKeyNotice /></>
}
