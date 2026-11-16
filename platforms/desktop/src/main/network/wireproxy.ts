import { app } from 'electron'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

import { findNative } from '../modules/natives'

const PLATFORM_DIR = `${process.platform}-${process.arch}`
const BIN_NAME = process.platform === 'win32' ? 'wireproxy.exe' : 'wireproxy'

/**
 * The wireproxy binary (the VPN tunnel) for this platform. The app doesn't carry it: it comes with
 * the module that uses the tunnel (native/<platform>/wireproxy in its package). A build run from
 * the sources (modules from their sources) takes HUB_WIREPROXY, else the module's copy next to the
 * apps: ../../hubbies/<id>/native/wireproxy/<platform>/wireproxy (the first module that has one).
 * Null: not installed (the VPN can't start).
 */
export function resolveWireproxyBinary(): string | null {
	const installed = findNative(BIN_NAME)
	if (installed) return installed
	if (app.isPackaged) return null
	if (process.env['HUB_WIREPROXY']) return existsSync(process.env['HUB_WIREPROXY']) ? process.env['HUB_WIREPROXY'] : null
	const modules = path.resolve(process.cwd(), '..', '..', 'modules')
	const dev = existsSync(modules)
		? readdirSync(modules).map(id => path.join(modules, id, 'native', 'wireproxy', PLATFORM_DIR, BIN_NAME)).find(p => existsSync(p))
		: undefined
	return dev ?? null
}
