import { useState } from 'react'
import { login, loginTwoFactor } from '@core/auth/login'
import { establishAuthState } from '@core/auth/authState'
import { get, set } from '@shared/store'
import { type FormData, Brand, Button, Form, InputField, SpoilerField } from '@cxxi-lab/hub-ui'

interface Credentials {
	email: string
	password: string
}

// The last email that logged in, prefilled on the next login. Kept out of
// STORE_KEY, whose keys bootAuth clears at every start.
const LAST_EMAIL_KEY = 'last_login_email'

export function LoginForm() {
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	const [lastEmail] = useState(() => get<string>(LAST_EMAIL_KEY) ?? '')
	// two-factor authentication on: the password was right, a code is asked
	const [challenge, setChallenge] = useState<string | null>(null)

	const handleSubmit = async (data: FormData) => {
		const { email, password } = data as Partial<Credentials>
		if (!email || !password) {
			setError('Invalid credentials')
			return
		}

		setError(null)
		setBusy(true)
		try {
			const auth = await login({ email, password })
			if (auth && 'twoFactor' in auth) {
				set(LAST_EMAIL_KEY, email)
				setChallenge(auth.challenge)
				return
			}
			if (!auth?.token || !auth?.expiresAt) {
				setError('Invalid credentials')
				return
			}
			set(LAST_EMAIL_KEY, email)
			await establishAuthState(auth.token, auth.expiresAt)
		}
		catch (err) {
			console.error('Login error', err)
			setError('Invalid credentials')
		}
		finally {
			setBusy(false)
		}
	}

	const handleCode = async (data: FormData) => {
		const { code } = data as { code?: string }
		if (!challenge || !code?.trim()) return
		setError(null)
		setBusy(true)
		try {
			const auth = await loginTwoFactor(challenge, code.trim())
			if (auth === 'expired') {
				setChallenge(null)
				setError('Too many attempts or too late: sign in again')
				return
			}
			if (!auth) {
				setError('Invalid code')
				return
			}
			await establishAuthState(auth.token, auth.expiresAt)
		}
		finally {
			setBusy(false)
		}
	}

	const actions = (
		<Button type="submit" label="Login" isLoading={busy} className="w-full" />
	)

	return (
		<div className="min-h-[calc(100vh-var(--status-bar-height))] flex flex-col items-center justify-center gap-8 p-8">
			<div className="scale-150">
				<Brand />
			</div>

			<div className="w-80">
				{challenge ? (
					<Form key="code" initialData={{ code: '' }} onSubmit={handleCode} actions={<Button type="submit" label="Verify" isLoading={busy} className="w-full" />}>
						<p className="m-0 text-center text-xs text-steel-300">
							Enter the code from your authenticator app, or a recovery code.
						</p>
						<InputField
							name="code"
							placeholder="Code"
							required
							autoFocus
							autoComplete="one-time-code"
						/>
						{error && <p className="text-center text-xs text-red-300">{error}</p>}
						<button
							type="button"
							onClick={() => { setChallenge(null); setError(null) }}
							className="self-center border-0 bg-transparent text-xs text-steel-300 cursor-pointer hover:text-white"
						>
							Back
						</button>
					</Form>
				) : (
				<Form key="password" initialData={{ email: lastEmail, password: '' }} onSubmit={handleSubmit} actions={actions}>
					<InputField
						name="email"
						type="email"
						placeholder="Email"
						required
						autoFocus={!lastEmail}
						autoComplete="email"
					/>
					{/* Email known: straight to the password. */}
					<SpoilerField
						name="password"
						placeholder="Password"
						required
						autoFocus={!!lastEmail}
						autoComplete="current-password"
					/>
					{error && (
						<p className="text-center text-xs text-red-300">{error}</p>
					)}
				</Form>
				)}
			</div>
		</div>
	)
}
