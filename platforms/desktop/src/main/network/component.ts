import { app, net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fsp, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'

import component from '../../../../tunnel/component.json'

/**
 * The tunnel, a component of the platform (platforms/tunnel/README.md, server
 * docs/plan-reseau-vpn.md): not in the AppImage, brought by no hubby. Downloaded the first time a
 * hubby going out through the VPN starts it, kept in the app's data, and run only if its sha256 is
 * the one this build pins (component.json). Removed when no installed hubby needs it.
 */

const PLATFORM = `${process.platform}-${process.arch}`

interface Pinned { name: string, asset: string, sha256: string }

const pinned: Pinned | null = (component.files as Record<string, Pinned>)[PLATFORM] ?? null

const root = (): string => path.join(app.getPath('userData'), 'components', 'tunnel')
const dir = (): string => path.join(root(), `v${component.version}`)

function sha256(file: string): string {
	return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** The pinned tunnel of this platform, if this build pins one (null: none published yet). */
function pin(): Pinned | null {
	return pinned && /^[0-9a-f]{64}$/.test(pinned.sha256) ? pinned : null
}

/** The tunnel already here and intact, or null. */
export function installedTunnel(): string | null {
	const wanted = pin()
	if (!wanted) return null
	const file = path.join(dir(), wanted.name)
	if (!existsSync(file)) return null
	if (sha256(file) !== wanted.sha256) {
		console.error('[tunnel] the installed tunnel does not match its pinned sha256: removed')
		rmSync(file, { force: true })
		return null
	}
	return file
}

let downloading: Promise<string | null> | null = null

/**
 * The tunnel, downloaded if it isn't here (and the other versions removed). Null: this build pins
 * none for this platform, or the download failed or doesn't match (never run then).
 */
export function ensureTunnel(): Promise<string | null> {
	const here = installedTunnel()
	if (here) return Promise.resolve(here)
	const wanted = pin()
	if (!wanted) return Promise.resolve(null)
	downloading ??= (async () => {
		const url = new URL(wanted.asset, component.url).href
		try {
			const response = await net.fetch(url)
			if (!response.ok) throw new Error(`HTTP ${response.status}`)
			const body = Buffer.from(await response.arrayBuffer())
			const sum = createHash('sha256').update(body).digest('hex')
			if (sum !== wanted.sha256) throw new Error(`sha256 ${sum}, expected ${wanted.sha256}`)
			await fsp.rm(root(), { recursive: true, force: true })
			await fsp.mkdir(dir(), { recursive: true })
			const file = path.join(dir(), wanted.name)
			await fsp.writeFile(`${file}.part`, body, { mode: 0o755 })
			await fsp.rename(`${file}.part`, file)
			console.log(`[tunnel] v${component.version} installed (${PLATFORM})`)
			return file
		}
		catch (err) {
			console.error(`[tunnel] download of ${url} failed:`, err)
			return null
		}
		finally {
			downloading = null
		}
	})()
	return downloading
}

/** No installed hubby needs the VPN any more: the tunnel goes. */
export function removeTunnel(): void {
	if (!existsSync(root())) return
	rmSync(root(), { recursive: true, force: true })
	console.log('[tunnel] removed: no hubby needs it')
}
