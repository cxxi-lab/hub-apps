import { registerPlugin } from '@capacitor/core'
import type { UpdateState, Unsubscribe } from './types'

// In-app sideload updater for the Android build. The server publishes, to the
// same VPN-only /releases/ path as the desktop AppImage, a signed manifest
// describing the latest APK. This module fetches it, verifies the Ed25519
// signature (same key as the desktop pipeline), and — when a newer versionCode
// is available — drives the native plugin to download, hash-check and install.
//
// Reaching hubbyware.cxxi.io requires the embedded tunnel; without it the fetch just
// fails and no update is surfaced (handled gracefully).

export const RELEASES_URL = 'https://hubbyware.cxxi.io/releases/'
const MANIFEST_FILE = 'latest-android.json'
const SIGNATURE_FILE = 'latest-android.json.sig'
const PERIODIC_CHECK_MS = 15 * 60_000

// Public half of the Ed25519 release key (GitHub secret UPDATE_SIGNING_KEY signs
// with the private half). Shared with the desktop updater: one key, both clients.
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAtFj52FIffQO6+p9PBENoZ9DaorX20Rz+6+GRwXDYfYo=
-----END PUBLIC KEY-----`

interface AppUpdaterPlugin {
	getCurrentVersion(): Promise<{ versionName: string; versionCode: number }>
	downloadAndInstall(options: { url: string; sha256?: string }): Promise<void>
	/** the system refused the install (its message) */
	addListener(event: 'installFailed', cb: (data: { error?: string }) => void): Promise<{ remove: () => Promise<void> }>
}

const AppUpdater = registerPlugin<AppUpdaterPlugin>('AppUpdater')

interface Manifest {
	versionName: string
	versionCode: number
	apk: string
	sha256: string
}

function pemToDer(pem: string): ArrayBuffer {
	const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
	const bin = atob(b64)
	const buffer = new ArrayBuffer(bin.length)
	const view = new Uint8Array(buffer)
	for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
	return buffer
}

export async function verifySignature(data: ArrayBuffer, signature: ArrayBuffer, spki: ArrayBuffer = pemToDer(PUBLIC_KEY_PEM)): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify'])
		return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, data)
	}
	catch (err) {
		console.warn('[updater] signature verification unavailable', err)
		return false
	}
}

export interface Updater {
	getState(): UpdateState | null
	subscribe(cb: (state: UpdateState) => void): Unsubscribe
	getCurrentVersion(): Promise<string>
	/** Resolves true once the signed manifest was read, whatever it offers. */
	check(): Promise<boolean>
	install(): Promise<void>
	skip(): void
}

export function createUpdater(): Updater {
	let state: UpdateState | null = null
	let latest: Manifest | null = null
	let currentName = '0.0.0'
	const listeners = new Set<(state: UpdateState) => void>()

	function emit(next: UpdateState): void {
		state = next
		for (const cb of listeners) cb(next)
	}

	async function check(): Promise<boolean> {
		try {
			const current = await AppUpdater.getCurrentVersion()
			currentName = current.versionName
			console.info(`[updater] checking (current ${current.versionName}, code ${current.versionCode})`)

			const [manifestRes, signatureRes] = await Promise.all([
				fetch(RELEASES_URL + MANIFEST_FILE, { cache: 'no-store' }),
				fetch(RELEASES_URL + SIGNATURE_FILE, { cache: 'no-store' })
			])
			if (!manifestRes.ok || !signatureRes.ok) {
				console.warn(`[updater] manifest unavailable (HTTP ${manifestRes.status}, signature HTTP ${signatureRes.status})`)
				return false
			}

			const manifestBytes = await manifestRes.arrayBuffer()
			const signature = await signatureRes.arrayBuffer()
			if (!(await verifySignature(manifestBytes, signature))) {
				console.warn('[updater] manifest signature mismatch — ignoring')
				return true
			}

			const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Manifest
			if (manifest.versionCode > current.versionCode) {
				console.info(`[updater] update available: ${manifest.versionName} (code ${manifest.versionCode})`)
				latest = manifest
				emit({ phase: 'available', version: manifest.versionName, currentVersion: currentName, progress: null, error: null })
			}
			else {
				console.info(`[updater] up to date (latest ${manifest.versionName}, code ${manifest.versionCode})`)
			}
			return true
		}
		catch (err) {
			console.warn('[updater] check failed', err)
			return false
		}
	}

	async function install(): Promise<void> {
		if (!latest) return
		const manifest = latest
		emit({ phase: 'downloading', version: manifest.versionName, currentVersion: currentName, progress: null, error: null })
		console.info(`[updater] installing ${manifest.versionName}`)
		try {
			// The native side downloads, verifies the SHA-256 and launches the
			// system installer; the user confirms the install.
			const failed = await AppUpdater.addListener('installFailed', ({ error }) => {
				emit({ phase: 'error', version: manifest.versionName, currentVersion: currentName, progress: null, error: error || 'The install failed' })
				void failed.remove()
			})
			await AppUpdater.downloadAndInstall({ url: RELEASES_URL + manifest.apk, sha256: manifest.sha256 })
			emit({ phase: 'installing', version: manifest.versionName, currentVersion: currentName, progress: null, error: null })
		}
		catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			console.warn('[updater] install failed', message)
			emit({ phase: 'error', version: manifest.versionName, currentVersion: currentName, progress: null, error: message })
		}
	}

	function skip(): void {
		latest = null
		state = null
	}

	// Periodic check, like the desktop updater. The first one is fired by the
	// platform once the tunnel is up (/releases/ is VPN-only), as on desktop.
	setInterval(() => void check(), PERIODIC_CHECK_MS)

	return {
		getState: () => state,
		subscribe(cb) {
			listeners.add(cb)
			return () => listeners.delete(cb)
		},
		getCurrentVersion: () => AppUpdater.getCurrentVersion().then(v => v.versionName).catch(() => '0.0.0'),
		check,
		install,
		skip
	}
}
