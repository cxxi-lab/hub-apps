import { useEffect, useState } from 'react'
import { api, ApiError, errorMessage } from '@core/api/client'
import { Button } from '@cxxi-lab/hub-ui'
import { DataKeySettings } from '@core/crypto/DataKeySettings'

interface TwoFactorState {
	enabled: boolean
	enabledAt: string | null
	recoveryCodesLeft: number
}

interface Setup {
	secret: string
	uri: string
	/** SVG, from the server */
	qr: string
}

type Step =
	| { kind: 'idle' }
	| { kind: 'setup', setup: Setup }
	| { kind: 'codes', codes: string[] }
	| { kind: 'confirm', action: 'disable' | 'renew' }

const INPUT = 'w-32 h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500 tabular-nums tracking-widest'

/**
 * The account's security: two-factor authentication (a code from an authenticator app after the
 * password; recovery codes for a lost phone). Turning it on, off or renewing the recovery codes
 * takes a code. Then the data key of this device (core/crypto).
 */
export function SettingsSecurity() {
	const [state, setState] = useState<TwoFactorState | null>(null)
	const [step, setStep] = useState<Step>({ kind: 'idle' })
	const [code, setCode] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const load = () => api<TwoFactorState>('/api/hub/account/2fa').then(setState).catch(err => setError(errorMessage(err)))
	useEffect(() => { void load() }, [])

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		try {
			await action()
		}
		catch (err) {
			setError(err instanceof ApiError && err.status === 422 ? 'Invalid code' : errorMessage(err))
		}
		finally {
			setBusy(false)
		}
	}

	const post = <T,>(path: string, body?: unknown) =>
		api<T>(`/api/hub/account/2fa${path}`, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })

	const startSetup = () => run(async () => {
		setStep({ kind: 'setup', setup: await post<Setup>('/setup') })
		setCode('')
	})

	const enable = () => run(async () => {
		const { recoveryCodes } = await post<{ recoveryCodes: string[] }>('/enable', { code })
		setStep({ kind: 'codes', codes: recoveryCodes })
		setCode('')
		await load()
	})

	const confirm = (action: 'disable' | 'renew') => run(async () => {
		if (action === 'disable') {
			await post('/disable', { code })
			setStep({ kind: 'idle' })
		}
		else {
			const { recoveryCodes } = await post<{ recoveryCodes: string[] }>('/recovery-codes', { code })
			setStep({ kind: 'codes', codes: recoveryCodes })
		}
		setCode('')
		await load()
	})

	const codeInput = (onEnter: () => void) => (
		<input
			value={code}
			onChange={e => { setCode(e.target.value); setError(null) }}
			onKeyDown={e => { if (e.key === 'Enter' && code.trim()) onEnter() }}
			placeholder="Code"
			autoComplete="one-time-code"
			autoFocus
			className={INPUT}
		/>
	)

	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
				<div>
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Two-factor authentication</h2>
					<p className="m-0 text-xs text-steel-300">
						After the password, a code from an authenticator app (Google Authenticator, Aegis…). Recovery codes sign in once each when the phone is lost.
					</p>
				</div>

				{state === null ? (
					<p className="m-0 text-xs text-steel-300">{error ?? 'Loading…'}</p>
				) : step.kind === 'setup' ? (
					<div className="flex flex-col gap-4">
						<p className="m-0 text-xs text-steel-100">1. Scan this QR code with the authenticator app (or type the key in it).</p>
						<div className="flex items-start gap-5 flex-wrap">
							{/* the server's own SVG: black on white, as the scanners want it */}
							<div className="bg-white p-2 rounded size-[200px] [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: step.setup.qr }} />
							<div className="flex flex-col gap-1 min-w-0">
								<span className="text-[10px] uppercase tracking-[1.5px] text-steel-500">Key</span>
								<code className="text-sm text-white break-all select-all font-mono">{step.setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
							</div>
						</div>
						<p className="m-0 text-xs text-steel-100">2. Enter the code it shows.</p>
						<div className="flex items-center gap-3">
							{codeInput(enable)}
							<Button label="Turn on" onClick={enable} isLoading={busy} isDisabled={!code.trim()} />
							<Button label="Cancel" color="secondary" onClick={() => { setStep({ kind: 'idle' }); setError(null) }} />
						</div>
					</div>
				) : step.kind === 'codes' ? (
					<div className="flex flex-col gap-3">
						<p className="m-0 text-xs text-steel-100">
							Recovery codes: keep them somewhere safe (a password manager). Each signs in once. They are shown only now.
						</p>
						<ul className="m-0 p-3 list-none grid grid-cols-2 gap-x-6 gap-y-1 w-fit bg-steel-950 border border-steel-700 rounded font-mono text-sm text-white select-all">
							{step.codes.map(c => <li key={c}>{c}</li>)}
						</ul>
						<div className="flex items-center gap-3">
							<Button label="Copy" color="secondary" onClick={() => void navigator.clipboard.writeText(step.codes.join('\n'))} />
							<Button label="Done" onClick={() => setStep({ kind: 'idle' })} />
						</div>
					</div>
				) : state.enabled ? (
					<div className="flex flex-col gap-3">
						<p className="m-0 text-xs text-steel-100">
							On since {state.enabledAt ? new Date(state.enabledAt).toLocaleDateString() : '—'}. {state.recoveryCodesLeft} recovery code{state.recoveryCodesLeft === 1 ? '' : 's'} left.
						</p>
						{step.kind === 'confirm' ? (
							<div className="flex items-center gap-3">
								{codeInput(() => void confirm(step.action))}
								<Button
									label={step.action === 'disable' ? 'Turn off' : 'Renew'}
									color={step.action === 'disable' ? 'danger' : 'primary'}
									onClick={() => void confirm(step.action)}
									isLoading={busy}
									isDisabled={!code.trim()}
								/>
								<Button label="Cancel" color="secondary" onClick={() => { setStep({ kind: 'idle' }); setCode(''); setError(null) }} />
							</div>
						) : (
							<div className="flex items-center gap-3">
								<Button label="New recovery codes" color="secondary" onClick={() => { setStep({ kind: 'confirm', action: 'renew' }); setCode('') }} />
								<Button label="Turn off" color="danger" onClick={() => { setStep({ kind: 'confirm', action: 'disable' }); setCode('') }} />
							</div>
						)}
					</div>
				) : (
					<div className="flex items-center gap-3">
						<p className="m-0 flex-1 text-xs text-steel-100">Off: the password alone signs in.</p>
						<Button label="Set up" onClick={() => void startSetup()} isLoading={busy} />
					</div>
				)}

				{error && state !== null && <p className="m-0 text-xs text-red-300">{error}</p>}
			</section>

			<DataKeySettings />
		</div>
	)
}
