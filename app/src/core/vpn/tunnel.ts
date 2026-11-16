import { platform, type VpnInfo } from '@platform'
import { isVpnPath } from '@core/module/declarations'

/**
 * Provisional (to be reviewed with the VPN): a call meant for the VPN-only name is not sent while
 * the tunnel is down — it would fail, or reach the public address and be refused there. A module's
 * pages and its sync then wait for the tunnel (TunnelGate starts it while the module is open).
 */

let status: VpnInfo['status'] = 'disabled'
if (platform.capabilities.vpn) {
	void platform.getVpnStatus().then(info => { status = info.status }).catch(() => {})
	platform.onVpnStatusChange(info => { status = info.status })
}

/** Whether a call to this path must wait for the tunnel. */
export const waitsForTunnel = (path: string): boolean => platform.capabilities.vpn && status !== 'connected' && isVpnPath(path)
