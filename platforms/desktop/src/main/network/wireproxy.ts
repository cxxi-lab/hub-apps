import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { findNative } from '../hubbies/natives'
import { ensureTunnel } from './component'

const PLATFORM_DIR = `${process.platform}-${process.arch}`
const BIN_NAME = process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy'

/**
 * The wireproxy binary (the VPN tunnel) for this platform. The app doesn't carry it: the platform
 * downloads it (./component.ts, pinned by its sha256). Until the hubby using the tunnel stops
 * bringing its own copy (native/<platform>/wireproxy in its package), that copy is the fallback.
 * A build run from the sources takes HUB_WIREPROXY, else the hubby's copy next to the apps:
 * ../../hubbies-user/<id>/native/wireproxy/<platform>/wireproxy. Null: none (the VPN can't start).
 */
export async function resolveWireproxyBinary(): Promise<string | null> {
	const component = await ensureTunnel()
	if (component) return component
	const installed = findNative(BIN_NAME)
	if (installed) return installed
	if (app.isPackaged) return null
	if (process.env['HUB_WIREPROXY']) return existsSync(process.env['HUB_WIREPROXY']) ? process.env['HUB_WIREPROXY'] : null
	const hubbies = path.resolve(process.cwd(), '..', '..', '..', 'hubbies-user')
	const dev = existsSync(hubbies)
		? readdirSync(hubbies).map(id => path.join(hubbies, id, 'native', 'wireproxy', PLATFORM_DIR, BIN_NAME)).find(p => existsSync(p))
		: undefined
	return dev ?? null
}
