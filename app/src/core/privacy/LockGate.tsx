import { useEffect, useState, type ReactNode } from 'react'
import { api, ApiError, errorMessage } from '@core/api/client'
import { isUnlocked, lock, setUnlocked, useLocks } from '@core/privacy/locks'
import { Button } from '@cxxi-lab/hub-ui'

/** without activity in an unlocked module for this long, it locks again */
const IDLE_MS = 10 * 60_000
const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const

/**
 * A module locked by a password of its own (Privacy): its pages show only once it is given (the
 * server answers its API only then). Leaving the module locks it again, its pages and their data
 * gone; so does a while without activity in it, or the server's word (the unlock ran out).
 */
export function LockGate({ module, label, active, children }: { module: string, label: string, active: boolean, children: ReactNode }) {
	useLocks()
	const unlocked = isUnlocked(module)

	// leaving it locks it, and so does its disappearing (hidden again, uninstalled)
	useEffect(() => {
		if (!active) lock(module)
	}, [active, module])
	useEffect(() => () => lock(module), [module])

	// idle in it
	useEffect(() => {
		if (!active || !unlocked) return
		let timer = setTimeout(() => lock(module), IDLE_MS)
		const reset = () => {
			clearTimeout(timer)
			timer = setTimeout(() => lock(module), IDLE_MS)
		}
		for (const e of ACTIVITY) window.addEventListener(e, reset, { passive: true })
		return () => {
			clearTimeout(timer)
			for (const e of ACTIVITY) window.removeEventListener(e, reset)
		}
	}, [active, unlocked, module])

	if (unlocked) return <>{children}</>
	return active ? <UnlockScreen module={module} label={label} /> : null
}

function UnlockScreen({ module, label }: { module: string, label: string }) {
	const [password, setPassword] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const submit = async () => {
		setBusy(true)
		setError(null)
		try {
			const { data } = await api<{ data: { token: string, expiresIn: number } }>(`/api/hub/privacy/${module}/unlock`, { method: 'POST', body: JSON.stringify({ password }) })
			setUnlocked(module, data.token, data.expiresIn)
		}
		catch (err) {
			setError(err instanceof ApiError && err.status === 403 ? 'Wrong password' : errorMessage(err))
			setPassword('')
		}
		finally {
			setBusy(false)
		}
	}

	return (
		<div className="absolute inset-0 z-20 flex items-center justify-center bg-steel-950">
			<form
				className="w-80 flex flex-col gap-3 p-6 bg-steel-900 border border-steel-700 rounded-md"
				onSubmit={e => { e.preventDefault(); if (password && !busy) void submit() }}
			>
				<h2 className="m-0 text-sm font-semibold text-white uppercase tracking-wider">{label} is locked</h2>
				<p className="m-0 text-xs text-steel-300">Its password, to open it.</p>
				<input
					type="password"
					value={password}
					onChange={e => setPassword(e.target.value)}
					autoFocus
					autoComplete="off"
					className="w-full h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500"
				/>
				{error && <p className="m-0 text-xs text-red-300">{error}</p>}
				<Button type="submit" label="Unlock" isLoading={busy} isDisabled={!password} className="w-full" />
			</form>
		</div>
	)
}
