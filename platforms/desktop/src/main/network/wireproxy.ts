import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { findNative } from '../hubbies/natives'

const PLATFORM_DIR = `${process.platform}-${process.arch}`
const BIN_NAME = process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy'

/**
 * The wireproxy binary (the VPN tunnel) for this platform. The app doesn't carry it: it comes with
 * the hubby that uses the tunnel (native/<platform>/wireproxy in its package). A build run from
 * the sources (hubbies from their sources) takes HUB_WIREPROXY, else the hubby's copy next to the
 * apps: ../../hubbies/<id>/native/wireproxy/<platform>/wireproxy (the first hubby that has one).
 * Null: not installed (the VPN can't start).
 */
export function resolveWireproxyBinary(): string | null {
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
