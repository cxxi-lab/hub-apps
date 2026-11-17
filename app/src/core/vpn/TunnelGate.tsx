import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { platform } from '@platform'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import { Button } from '@cxxi-lab/hubbyware-ui'

/**
 * The VPN tunnel of a hubby that uses it (`supports: ['vpn']`, i.e. Private): it runs only while
 * the hubby is open. Entering starts it, and the hubby's pages wait for it (their calls only go
 * through it); leaving stops it. Down later (lost, reconnecting), the pages stay, under a notice.
 */
/** the open pages needing the tunnel; it stops when none is left */
let openGates = 0

export function TunnelGate({ hubby, active, children }: { hubby: string, active: boolean, children: ReactNode }) {
	const vpn = useVpnStatus()
	const navigate = useNavigate()
	const [ready, setReady] = useState(false)

	// Open: the tunnel runs. Left, or the hubby gone while open (hidden again: Ctrl+Alt+Q, /hide;
	// uninstalled): it stops, once no page needs it any more (a moment later: a page remounting, as
	// React does in development, keeps it).
	useEffect(() => {
		if (!active) return
		openGates++
		void platform.getVpnStatus().then(info => {
			if (info.hubby !== hubby || (info.status !== 'connected' && info.status !== 'starting')) void platform.startVpn(hubby)
		})
		return () => {
			openGates--
			setTimeout(() => { if (openGates === 0) void platform.stopVpn() }, 0)
		}
	}, [active])

	useEffect(() => {
		if (active && vpn.status === 'connected') setReady(true)
	}, [active, vpn.status])

	const notice = active && vpn.status !== 'connected' && (
		<div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-steel-950/95 text-sm text-steel-300">
			{vpn.status === 'starting' ? (
				<>
					<div className="size-8 border-[3px] border-steel-800 border-t-primary-500 rounded-full animate-spin" />
					<span>Connecting to the VPN…</span>
				</>
			) : (
				<>
					<span className="text-white">The VPN isn't connected</span>
					{vpn.error && <span className="max-w-md text-center text-xs text-red-300 break-words">{vpn.error}</span>}
					<div className="flex gap-2">
						<Button label="Retry" onClick={() => void platform.startVpn(hubby)} />
						<Button label="VPN settings" color="secondary" onClick={() => navigate(`/hubbies/${hubby}`)} />
					</div>
				</>
			)}
		</div>
	)

	return (
		<>
			{ready && children}
			{notice}
		</>
	)
}
