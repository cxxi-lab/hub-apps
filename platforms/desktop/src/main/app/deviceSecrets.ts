import { app, ipcMain, safeStorage } from 'electron'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The secrets this device keeps for the app (platform.getDeviceSecret): the account's data key
 * (app core/crypto). Encrypted by the OS through safeStorage (the keyring: libsecret / KWallet on
 * Linux, Keychain, DPAPI), in the profile's device-secrets.json. Never leaves this process but to
 * the app's own windows.
 */
const FILE = () => join(app.getPath('userData'), 'device-secrets.json')
const NAME = /^[\w.@:/#-]{1,200}$/

function load(): Record<string, string> {
	try {
		return existsSync(FILE()) ? JSON.parse(readFileSync(FILE(), 'utf8')) : {}
	}
	catch {
		return {}
	}
}

function save(entries: Record<string, string>): void {
	const tmp = `${FILE()}.tmp`
	writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 })
	renameSync(tmp, FILE())
}

ipcMain.handle('device-secret:get', (_, name: unknown): string | null => {
	if (typeof name !== 'string' || !NAME.test(name)) return null
	const sealed = load()[name]
	if (!sealed) return null
	try {
		return safeStorage.decryptString(Buffer.from(sealed, 'base64'))
	}
	catch (err) {
		console.error('[device-secrets] cannot decrypt', name, err)
		return null
	}
})

ipcMain.handle('device-secret:set', (_, name: unknown, value: unknown): void => {
	if (typeof name !== 'string' || !NAME.test(name)) throw new Error('invalid secret name')
	const entries = load()
	if (value === null) delete entries[name]
	else if (typeof value === 'string') {
		if (!safeStorage.isEncryptionAvailable()) throw new Error('The system cannot encrypt secrets (no keyring)')
		entries[name] = safeStorage.encryptString(value).toString('base64')
	}
	else throw new Error('invalid secret value')
	save(entries)
})
