import { useCallback, useEffect, useState } from 'react'
import { faFolderOpen, faPaste, faPlay, faRotateRight, faStop, faTrash } from '@fortawesome/free-solid-svg-icons'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { platform, type VpnStatus } from '@platform'
import type { HubbyManifest } from '@core/hubby/types'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'

const DOT_COLOR: Record<VpnStatus, string> = {
	connected: 'bg-product-green shadow-[0_0_4px_rgba(63,185,80,0.6)]',
	starting: 'bg-product-yellow shadow-[0_0_4px_rgba(210,153,34,0.6)] animate-pulse',
	error: 'bg-red-500 shadow-[0_0_4px_rgba(229,72,77,0.6)]',
	disabled: 'bg-steel-700',
}

const STATUS_LABEL: Record<VpnStatus, string> = {
	connected: 'Connected',
	starting: 'Connecting…',
	error: 'Error',
	disabled: 'Off',
}

/**
 * A hubby's VPN (its settings' common part, for a hubby going out through the VPN; server
 * docs/plan-reseau-vpn.md): the user's own WireGuard config, kept by the shell for this hubby (the
 * hubby never reads it), and its tunnel, which runs while the hubby is open.
 */
export function VpnSettings({ hubby: m }: { hubby: HubbyManifest }) {
	const vpn = useVpnStatus()
	const [config, setConfig] = useState<{ configured: boolean, endpoint: string | null } | null>(null)
	const [pasting, setPasting] = useState(false)
	const [text, setText] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const reload = useCallback(() => {
		platform.getVpnConfig(m.id).then(setConfig).catch(() => setConfig({ configured: false, endpoint: null }))
	}, [m.id])
	useEffect(reload, [reload])

	// the tunnel's state, when it runs for this hubby
	const ours = vpn.hubby === m.id || vpn.hubby === undefined
	const status: VpnStatus = ours ? vpn.status : 'disabled'

	const run = async (action: () => Promise<{ ok: boolean, error?: string } | void>) => {
		setBusy(true)
		setError(null)
		try {
			const result = await action()
			if (result && !result.ok && result.error && result.error !== 'cancelled') setError(result.error)
			reload()
		}
		catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		}
		finally {
			setBusy(false)
		}
	}

	const savePasted = () => run(async () => {
		const result = await platform.setVpnConfig(m.id, text)
		if (result.ok) {
			setText('')
			setPasting(false)
		}
		return result
	})

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5">
			<header className="flex items-center justify-between mb-3">
				<h2 className="m-0 text-sm font-semibold text-white uppercase tracking-wider">VPN</h2>
				<span className="flex items-center gap-2 text-sm">
					<span className={`inline-block size-2.5 rounded-full ${DOT_COLOR[status]}`} />
					<span className="text-white">{STATUS_LABEL[status]}</span>
				</span>
			</header>
			<p className="m-0 mb-4 text-xs text-steel-300">
				{m.label}'s sites and players go out through your VPN, never from your own address. Use your
				own WireGuard config (your VPN provider's, your router's…): it stays on this device, encrypted,
				and the tunnel runs while {m.label} is open.
			</p>

			<dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-xs mb-4">
				<dt className="text-steel-300">Config</dt>
				<dd className="text-white m-0">{config === null ? '…' : config.configured ? 'Added' : 'None yet'}</dd>
				<dt className="text-steel-300">Endpoint</dt>
				<dd className="text-white font-mono break-all m-0">{config?.endpoint ?? '—'}</dd>
				{ours && vpn.port !== null && (
					<>
						<dt className="text-steel-300">Proxy port</dt>
						<dd className="text-white font-mono m-0">{vpn.port}</dd>
					</>
				)}
			</dl>

			{(error ?? (ours ? vpn.error : null)) && (
				<div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-300 break-words">
					{error ?? vpn.error}
				</div>
			)}

			<div className="flex flex-wrap gap-2">
				<Button icon={faFolderOpen} label={config?.configured ? 'Replace config…' : 'Add config…'} color="primary" isDisabled={busy} onClick={() => run(() => platform.replaceVpnConfig(m.id))} />
				<Button icon={faPaste} label="Paste config" color="secondary" isDisabled={busy} onClick={() => setPasting(p => !p)} />
				{config?.configured && (
					<>
						{status === 'connected' || status === 'starting'
							? <Button icon={faStop} label="Stop" color="secondary" isDisabled={busy} onClick={() => run(() => platform.stopVpn())} />
							: <Button icon={faPlay} label="Start" color="secondary" isDisabled={busy} onClick={() => run(() => platform.startVpn(m.id))} />}
						<Button icon={faRotateRight} label="Reload" color="secondary" isDisabled={busy} onClick={() => run(async () => { await platform.stopVpn(); await platform.startVpn(m.id) })} />
						<Button icon={faTrash} label="Remove config" color="danger" isDisabled={busy} onClick={() => run(() => platform.removeVpnConfig(m.id))} />
					</>
				)}
			</div>

			{pasting && (
				<div className="mt-4 flex flex-col gap-2">
					<textarea
						value={text}
						onChange={e => setText(e.target.value)}
						rows={10}
						spellCheck={false}
						placeholder={'[Interface]\nPrivateKey = …\nAddress = …\n\n[Peer]\nPublicKey = …\nEndpoint = …\nAllowedIPs = 0.0.0.0/0'}
						className="w-full p-3 bg-steel-950 border border-steel-700 rounded text-xs font-mono text-white resize-y"
					/>
					<div className="flex gap-2">
						<Button label="Save" color="primary" isDisabled={busy || !text.trim()} onClick={savePasted} />
						<Button label="Cancel" color="secondary" isDisabled={busy} onClick={() => { setText(''); setPasting(false) }} />
					</div>
				</div>
			)}
		</section>
	)
}
