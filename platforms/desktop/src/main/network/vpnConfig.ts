import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

/**
 * The user's VPN configs (server docs/plan-reseau-vpn.md, phase 3): a WireGuard config per hubby
 * going out through the VPN, the user's own (their provider's, their router's…). Kept by the
 * platform, sealed by the OS (safeStorage: the keyring), in the profile's vpn/ folder; only this
 * process reads it (to start the tunnel): neither the hubby nor the renderer ever gets it back,
 * only whether there is one and its endpoint.
 */

const HUBBY = /^[a-z0-9-]{1,80}$/

const dir = (): string => path.join(app.getPath('userData'), 'vpn')
const sealedFile = (hubby: string): string => path.join(dir(), `${hubby}.conf.sealed`)
/** Before configs were per hubby: one config for the device, in clear. */
const legacyFile = (): string => path.join(app.getPath('userData'), 'vpn.conf')

let lookup: (() => string[]) | null = null

/** The hubby manager registers how to list the installed hubbies going out through the VPN. */
export function registerVpnHubbies(list: () => string[]): void {
	lookup = list
}

/** The hubby whose tunnel is meant when none is named (an older hubby bundle): the first going out through the VPN. */
export function defaultVpnHubby(): string | null {
	return lookup?.()[0] ?? null
}

export function validHubby(hubby: unknown): hubby is string {
	return typeof hubby === 'string' && HUBBY.test(hubby)
}

/** Why a text isn't a usable WireGuard config (null: it is). */
export function invalidConfig(text: string): string | null {
	const sections = [...text.matchAll(/^\s*\[(\w+)\]\s*$/gm)].map(m => m[1].toLowerCase())
	if (sections.filter(s => s === 'interface').length !== 1) return 'not a WireGuard config: it needs one [Interface]'
	if (sections.filter(s => s === 'peer').length !== 1) return 'the tunnel takes a config with exactly one [Peer]'
	if (!/^\s*PrivateKey\s*=\s*\S+/im.test(text)) return 'the [Interface] has no PrivateKey'
	if (!/^\s*Address\s*=\s*\S+/im.test(text)) return 'the [Interface] has no Address'
	if (!/^\s*PublicKey\s*=\s*\S+/im.test(text)) return 'the [Peer] has no PublicKey'
	if (!/^\s*Endpoint\s*=\s*\S+/im.test(text)) return 'the [Peer] has no Endpoint'
	return null
}

export function endpointOf(text: string): string | null {
	return text.match(/^\s*Endpoint\s*=\s*(.+)$/im)?.[1].trim() ?? null
}

/** Saves a hubby's config (sealed). Throws when the text isn't a config or the OS can't seal it. */
export function writeConfig(hubby: string, text: string): void {
	const invalid = invalidConfig(text)
	if (invalid) throw new Error(invalid)
	if (!safeStorage.isEncryptionAvailable()) throw new Error('The system cannot encrypt the VPN config (no keyring)')
	mkdirSync(dir(), { recursive: true, mode: 0o700 })
	const tmp = `${sealedFile(hubby)}.tmp`
	writeFileSync(tmp, safeStorage.encryptString(text), { mode: 0o600 })
	renameSync(tmp, sealedFile(hubby))
}

export function removeConfig(hubby: string): void {
	rmSync(sealedFile(hubby), { force: true })
}

/**
 * A hubby's config, in clear (for the tunnel only). The device's former single config is taken
 * over by the first hubby asking (sealed, then the clear file removed). A build run from its
 * sources falls back on ./vpn.conf.
 */
export function readConfig(hubby: string): string | null {
	if (existsSync(sealedFile(hubby))) {
		try {
			return safeStorage.decryptString(readFileSync(sealedFile(hubby)))
		}
		catch (err) {
			console.error(`[vpn] cannot decrypt the config of ${hubby}`, err)
			return null
		}
	}
	if (existsSync(legacyFile())) {
		const text = readFileSync(legacyFile(), 'utf8')
		try {
			writeConfig(hubby, text)
			rmSync(legacyFile(), { force: true })
			console.log(`[vpn] the device's config is now ${hubby}'s (sealed)`)
		}
		catch (err) {
			console.warn('[vpn] the former config stays as it is:', err)
		}
		return text
	}
	if (!app.isPackaged) {
		const dev = path.join(process.cwd(), 'vpn.conf')
		if (existsSync(dev)) return readFileSync(dev, 'utf8')
	}
	return null
}

/** What the settings show of a hubby's config: whether there is one, and its endpoint. */
export function configInfo(hubby: string): { configured: boolean, endpoint: string | null } {
	const text = existsSync(sealedFile(hubby)) || existsSync(legacyFile()) ? readConfig(hubby) : null
	return { configured: text !== null, endpoint: text ? endpointOf(text) : null }
}
