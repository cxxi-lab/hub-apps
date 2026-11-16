import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import { useEffect } from 'react'
import { useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import { useDeveloperMode } from '@core/settings/developer'
import { useDevMode } from '@core/contexts/DevModeContext'
import { getApiBaseUrl } from '@core/api/baseUrl'
import type { VpnStatus } from '@platform'
import { platform } from '@platform'
import { AiEngineStatus } from './AiEngineStatus'
import { CommandConsole } from './CommandConsole'

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
	disabled: 'Disabled',
}

/**
 * The state of the background pieces: local mode, the AI engine, the VPN tunnel while it runs
 * (`always`: its state even when off, as the phone's console shows it).
 */
export function StatusItems({ always = false }: { always?: boolean }) {
	const vpn = useVpnStatus()
	const devMode = useDevMode()
	return (
		<>
			{devMode && (
				<span className="text-product-yellow tracking-wide" title={`API target: ${getApiBaseUrl()}`}>
					LOCAL MODE
				</span>
			)}
			{platform.capabilities.companion && <AiEngineStatus />}
			{(always || vpn.status !== 'disabled') && (
				<span className="inline-flex items-center gap-1.5 tracking-wide px-1 py-0.5" title={`VPN: ${STATUS_LABEL[vpn.status]}${vpn.error ? ` (${vpn.error})` : ''}`}>
					VPN
					<span className={`inline-block size-1.5 rounded-full -translate-y-px ${DOT_COLOR[vpn.status]}`} />
					{always && <span>{STATUS_LABEL[vpn.status]}{vpn.error ? ` (${vpn.error})` : ''}</span>}
				</span>
			)}
		</>
	)
}

/**
 * The bottom bar, in developer mode (not on phones: their console opens from the logo): the
 * command console, then the state of the background pieces (Private's settings hold the VPN's
 * details). The layout makes room for it through --status-bar-height.
 */
export function StatusBar() {
	const phone = useMediaQuery('(width < 40rem)')
	const developer = useDeveloperMode()
	const shown = developer && !phone
	useEffect(() => {
		document.documentElement.style.setProperty('--status-bar-height', shown ? '26px' : '0px')
	}, [shown])
	if (!shown) return null
	return (
		<footer className="fixed bottom-0 inset-x-0 h-(--status-bar-height) flex items-center gap-3 px-3 font-mono text-[9px] text-steel-500 bg-steel-1000 border-t border-black/40 select-none z-50">
			<CommandConsole />
			<div className="ml-auto flex items-center gap-3">
				<StatusItems />
			</div>
		</footer>
	)
}
