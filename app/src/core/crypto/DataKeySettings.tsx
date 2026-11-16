import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { api, ApiError, errorMessage } from '@core/api/client'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { adoptDataKey, rawDataKey, useDataKey } from './dataKey'
import { fromRecoveryCode, recoveryCode } from './format'
import { parseLinkCode, showLink, useLinkCode, type ShownLink } from './link'

const INPUT = 'w-full h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500 font-mono'

type Step =
	| { kind: 'idle' }
	| { kind: 'show', link: ShownLink, qr: string }
	| { kind: 'scan' }
	| { kind: 'type' }
	| { kind: 'recovery-ask' }
	| { kind: 'recovery-show', code: string }
	| { kind: 'recovery-enter' }

/**
 * The account's data key on this device (docs/plan-storage-encryption.md § 2): whether it holds
 * it, linking another device (or this one) by a code to scan or type, and the recovery key.
 */
export function DataKeySettings() {
	const key = useDataKey()
	const [step, setStep] = useState<Step>({ kind: 'idle' })
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const ready = key.status === 'ready'

	// a shown code is closed when leaving it
	useEffect(() => () => { if (step.kind === 'show') step.link.cancel() }, [step])

	const reset = (message: string | null = null) => {
		setStep({ kind: 'idle' })
		setText('')
		setBusy(false)
		setNotice(message)
	}

	const run = async (action: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			await action()
		}
		catch (err) {
			setError(errorMessage(err))
		}
		finally {
			setBusy(false)
		}
	}

	const show = () => run(async () => {
		const link = await showLink()
		const qr = await QRCode.toString(link.code, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
		setStep({ kind: 'show', link, qr })
		link.done.then(
			() => reset(rawDataKey() && !ready ? 'This device is linked: it holds the key now.' : 'The other device is linked.'),
			err => { if (err instanceof Error && err.message !== 'Cancelled') { setError(err.message); setStep({ kind: 'idle' }) } }
		)
	})

	const use = (code: string) => run(async () => {
		const result = await useLinkCode(code)
		reset(result === 'received' ? 'This device is linked: it holds the key now.' : 'Key sent: the other device is linked.')
	})

	const askRecovery = () => run(async () => {
		try {
			await api('/api/hub/data-key/password', { method: 'POST', body: JSON.stringify({ password: text }) })
		}
		catch (err) {
			throw err instanceof ApiError && err.status === 403 ? new Error('Wrong password') : err
		}
		const raw = rawDataKey()
		if (!raw) throw new Error('This device has no key')
		setText('')
		setStep({ kind: 'recovery-show', code: recoveryCode(raw) })
	})

	const enterRecovery = () => run(async () => {
		await adoptDataKey(fromRecoveryCode(text))
		reset('This device holds the key now.')
	})

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
			<div>
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Data encryption</h2>
				<p className="m-0 text-xs text-steel-300">
					Your sensitive data is encrypted on your devices with a key that only they hold: the server stores it sealed and can't read it.
					A new device gets the key from one of yours (scan or type the code one of them shows), or from the recovery key.
				</p>
			</div>

			<p className="m-0 text-xs text-steel-100">
				{key.status === 'loading' ? 'Loading…'
					: key.status === 'error' ? `The key could not be loaded: ${key.error}`
					: key.status === 'ready' ? 'This device holds the key.'
					: 'This device is not linked yet: the encrypted data can\'t be read here.'}
			</p>

			{step.kind === 'show' ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 text-xs text-steel-100">
						{ready
							? 'On the other device: Settings → Security → Scan a code (or Type a code). This device gives it the key.'
							: 'On a device that holds the key: Settings → Security → Scan a code (or Type a code).'}
						{' '}Valid 5 minutes, once.
					</p>
					<div className="flex items-start gap-5 flex-wrap">
						{/* our own SVG (qrcode): black on white, as the scanners want it */}
						<div className="bg-white p-2 rounded size-[220px] [&>svg]:size-full" dangerouslySetInnerHTML={{ __html: step.qr }} />
						<div className="flex flex-col gap-2 min-w-0 max-w-sm">
							<span className="text-[10px] uppercase tracking-[1.5px] text-steel-500">Or type this code</span>
							<code className="text-xs text-white break-all select-all font-mono">{step.link.code}</code>
							<div><Button label="Copy" color="secondary" onClick={() => void navigator.clipboard.writeText(step.link.code)} /></div>
						</div>
					</div>
					<p className="m-0 text-xs text-steel-400">Waiting for the other device…</p>
					<div><Button label="Cancel" color="secondary" onClick={() => reset()} /></div>
				</div>
			) : step.kind === 'scan' ? (
				<div className="flex flex-col gap-3">
					<Scanner onCode={code => { setStep({ kind: 'idle' }); void use(code) }} onError={message => { setError(message); setStep({ kind: 'idle' }) }} />
					<div><Button label="Cancel" color="secondary" onClick={() => reset()} /></div>
				</div>
			) : step.kind === 'type' ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 text-xs text-steel-100">The code the other device shows (hub1.…).</p>
					<input value={text} onChange={e => { setText(e.target.value); setError(null) }} placeholder="hub1.…" autoFocus className={INPUT} />
					<div className="flex items-center gap-3">
						<Button label="Link" onClick={() => void use(text)} isLoading={busy} isDisabled={!parseLinkCode(text)} />
						<Button label="Cancel" color="secondary" onClick={() => reset()} />
					</div>
				</div>
			) : step.kind === 'recovery-ask' ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 text-xs text-steel-100">Your account's password, to show the recovery key.</p>
					<input type="password" value={text} onChange={e => { setText(e.target.value); setError(null) }} onKeyDown={e => { if (e.key === 'Enter' && text) void askRecovery() }} autoFocus className={INPUT} />
					<div className="flex items-center gap-3">
						<Button label="Show" onClick={() => void askRecovery()} isLoading={busy} isDisabled={!text} />
						<Button label="Cancel" color="secondary" onClick={() => reset()} />
					</div>
				</div>
			) : step.kind === 'recovery-show' ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 text-xs text-steel-100">
						The recovery key is the data key itself. Keep it somewhere safe, apart from this device (a password manager, on paper).
						Without it, losing all your devices loses the encrypted data, for good: nobody else holds the key.
					</p>
					<code className="p-3 w-fit bg-steel-950 border border-steel-700 rounded font-mono text-sm text-white select-all break-all">{step.code}</code>
					<div className="flex items-center gap-3">
						<Button label="Copy" color="secondary" onClick={() => void navigator.clipboard.writeText(step.code)} />
						<Button label="Done" onClick={() => reset()} />
					</div>
				</div>
			) : step.kind === 'recovery-enter' ? (
				<div className="flex flex-col gap-3">
					<p className="m-0 text-xs text-steel-100">The recovery key (52 characters, the dashes don't matter).</p>
					<input value={text} onChange={e => { setText(e.target.value); setError(null) }} placeholder="XXXX-XXXX-…" autoFocus className={INPUT} />
					<div className="flex items-center gap-3">
						<Button label="Use" onClick={() => void enterRecovery()} isLoading={busy} isDisabled={!text.trim()} />
						<Button label="Cancel" color="secondary" onClick={() => reset()} />
					</div>
				</div>
			) : key.status === 'ready' || key.status === 'missing' ? (
				<div className="flex items-center gap-3 flex-wrap">
					<Button label={ready ? 'Link a device' : 'Show a code'} onClick={() => void show()} isLoading={busy} />
					{canScan() && <Button label="Scan a code" color="secondary" onClick={() => { setError(null); setStep({ kind: 'scan' }) }} />}
					<Button label="Type a code" color="secondary" onClick={() => { setError(null); setText(''); setStep({ kind: 'type' }) }} />
					{ready
						? <Button label="Recovery key" color="secondary" onClick={() => { setError(null); setText(''); setStep({ kind: 'recovery-ask' }) }} />
						: <Button label="Use the recovery key" color="secondary" onClick={() => { setError(null); setText(''); setStep({ kind: 'recovery-enter' }) }} />}
				</div>
			) : null}

			{notice && <p className="m-0 text-xs text-emerald-300">{notice}</p>}
			{error && <p className="m-0 text-xs text-red-300">{error}</p>}
		</section>
	)
}

const canScan = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

/** The camera, until a link code shows in it. */
function Scanner({ onCode, onError }: { onCode: (code: string) => void, onError: (message: string) => void }) {
	const video = useRef<HTMLVideoElement>(null)

	useEffect(() => {
		let stream: MediaStream | null = null
		let frame = 0
		let stopped = false
		const canvas = document.createElement('canvas')
		const context = canvas.getContext('2d', { willReadFrequently: true })

		const tick = () => {
			if (stopped) return
			const v = video.current
			if (v && context && v.readyState >= 2 && v.videoWidth) {
				canvas.width = v.videoWidth
				canvas.height = v.videoHeight
				context.drawImage(v, 0, 0)
				const found = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })
				if (found && parseLinkCode(found.data)) {
					stopped = true
					onCode(found.data)
					return
				}
			}
			frame = requestAnimationFrame(tick)
		}

		navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
			.then(s => {
				stream = s
				if (stopped) return
				if (video.current) {
					video.current.srcObject = s
					void video.current.play()
				}
				frame = requestAnimationFrame(tick)
			})
			.catch(err => onError(`The camera is not available: ${err instanceof Error ? err.message : String(err)}. Type the code instead.`))

		return () => {
			stopped = true
			cancelAnimationFrame(frame)
			stream?.getTracks().forEach(t => t.stop())
		}
	}, [])

	return (
		<div className="flex flex-col gap-2">
			<p className="m-0 text-xs text-steel-100">Point the camera at the code the other device shows.</p>
			<video ref={video} muted playsInline className="w-full max-w-sm aspect-square object-cover rounded bg-black" />
		</div>
	)
}
