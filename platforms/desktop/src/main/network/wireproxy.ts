import { ensureTunnel } from './component'

/**
 * The wireproxy binary (the VPN tunnel) for this platform: a component of the platform, downloaded
 * when a hubby needs it and run only if its sha256 is the pinned one (./component.ts). Null: none
 * (the VPN can't start).
 */
export function resolveWireproxyBinary(): Promise<string | null> {
	return ensureTunnel()
}
