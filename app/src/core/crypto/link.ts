import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { api, ApiError } from '@core/api/client'
import { adoptDataKey, rawDataKey } from './dataKey'
import { base64url, concat, fromBase64url, randomBytes } from './format'

/**
 * Linking two devices of an account, Signal-like (docs/plan-storage-encryption.md § 2): one shows
 * a code (QR, or text to copy) holding a link's id and a one-time secret; the other scans or types
 * it. Whichever holds the data key puts it in the link sealed by the secret; the other takes it.
 * So either may show the code: the phone scans the desktop's in both orders of installation. The
 * server relays the sealed key (5 minutes) without the secret, which only went through the code.
 */

const CODE = /^hub1\.([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/
const POLL_MS = 1500

const linkPath = (id: string) => `/api/hub/device-links/${id}`
const aad = (id: string) => new TextEncoder().encode(`hub-link|${id}`)

function sealKey(secret: Uint8Array, id: string, key: Uint8Array): string {
	const nonce = randomBytes(24)
	return base64url(concat(nonce, xchacha20poly1305(secret, nonce, aad(id)).encrypt(key)))
}

function openKey(secret: Uint8Array, id: string, payload: string): Uint8Array {
	const bytes = fromBase64url(payload)
	try {
		return xchacha20poly1305(secret, bytes.subarray(0, 24), aad(id)).decrypt(bytes.subarray(24))
	}
	catch {
		throw new Error('The key received could not be opened: start again with a new code')
	}
}

export function parseLinkCode(code: string): { id: string, secret: Uint8Array } | null {
	const m = code.trim().match(CODE)
	return m ? { id: m[1], secret: fromBase64url(m[2]) } : null
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export interface ShownLink {
	code: string
	expiresAt: number
	/** resolves once the other device has its key (or this one has the other's) */
	done: Promise<void>
	cancel(): void
}

/** This device shows a code. */
export async function showLink(): Promise<ShownLink> {
	const { id, expiresIn } = await api<{ id: string, expiresIn: number }>('/api/hub/device-links', { method: 'POST' })
	const secret = randomBytes(32)
	const key = rawDataKey()
	if (key) await api(linkPath(id), { method: 'PUT', body: JSON.stringify({ payload: sealKey(secret, id, key) }) })
	const expiresAt = Date.now() + expiresIn * 1000
	let cancelled = false

	const done = (async () => {
		while (!cancelled) {
			if (Date.now() > expiresAt) throw new Error('The code expired: show a new one')
			await sleep(POLL_MS)
			if (cancelled) break
			let payload: string | null
			try {
				payload = (await api<{ payload: string | null }>(linkPath(id))).payload
			}
			catch (err) {
				// the other device took the key and closed the link
				if (key && err instanceof ApiError && err.status === 404) return
				throw err
			}
			if (!key && payload) {
				await adoptDataKey(openKey(secret, id, payload))
				await api(linkPath(id), { method: 'DELETE' }).catch(() => {})
				return
			}
		}
		throw new Error('Cancelled')
	})()

	return {
		code: `hub1.${id}.${base64url(secret)}`,
		expiresAt,
		done,
		cancel() {
			cancelled = true
			void api(linkPath(id), { method: 'DELETE' }).catch(() => {})
		}
	}
}

/** This device uses another's code (scanned or typed). Resolves once the key went where needed. */
export async function useLinkCode(code: string): Promise<'sent' | 'received'> {
	const link = parseLinkCode(code)
	if (!link) throw new Error('Not a link code (hub1.…)')
	const key = rawDataKey()
	if (key) {
		try {
			await api(linkPath(link.id), { method: 'PUT', body: JSON.stringify({ payload: sealKey(link.secret, link.id, key) }) })
		}
		catch (err) {
			if (err instanceof ApiError && err.status === 409) throw new Error('Both devices already hold the key')
			if (err instanceof ApiError && err.status === 404) throw new Error('This code expired, or belongs to another account')
			throw err
		}
		return 'sent'
	}
	const until = Date.now() + 60_000
	for (;;) {
		let payload: string | null
		try {
			payload = (await api<{ payload: string | null }>(linkPath(link.id))).payload
		}
		catch (err) {
			if (err instanceof ApiError && err.status === 404) throw new Error('This code expired, or belongs to another account')
			throw err
		}
		if (payload) {
			await adoptDataKey(openKey(link.secret, link.id, payload))
			await api(linkPath(link.id), { method: 'DELETE' }).catch(() => {})
			return 'received'
		}
		if (Date.now() > until) throw new Error('Neither device holds the key: use a device that does, or the recovery key')
		await sleep(POLL_MS)
	}
}
