import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

/**
 * The formats of the data encryption (docs/plan-storage-encryption.md § 2–3), all on the device:
 *  - the account's data key: 32 bytes from the system's CSPRNG (crypto.getRandomValues);
 *  - its subkeys (HKDF-SHA256): one seals the fields, one makes the blind indexes, one names the
 *    key (its fingerprint, the only thing the server knows of it);
 *  - a sealed value: `v1:` + base64url(nonce ‖ ciphertext ‖ tag), XChaCha20-Poly1305 with a random
 *    24-byte nonce, and where the value belongs as associated data (`module/collection/id/field`:
 *    a value copied to another document, field or account doesn't open);
 *  - a blind index: HMAC-SHA256 of the normalized value (lowercase, no spaces), scoped by
 *    `module/collection/field`, 16 bytes, base64url.
 */

export const PREFIX = 'v1:'
const SEALED = /^v1:[A-Za-z0-9_-]{54,}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface DataKeys {
	fields: Uint8Array
	index: Uint8Array
	/** the key's fingerprint (16 bytes, base64url) */
	id: string
}

export function randomBytes(length: number): Uint8Array {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	return bytes
}

/** A new data key (what the first device makes). */
export const newDataKey = (): Uint8Array => randomBytes(32)

export function deriveKeys(key: Uint8Array): DataKeys {
	if (key.length !== 32) throw new Error('A data key is 32 bytes')
	const sub = (info: string, length = 32) => hkdf(sha256, key, undefined, encoder.encode(info), length)
	return { fields: sub('hub-data/fields'), index: sub('hub-data/index'), id: base64url(sub('hub-data/key-id', 16)) }
}

export const isSealed = (value: unknown): value is string => typeof value === 'string' && SEALED.test(value)

export function seal(key: Uint8Array, where: string, plain: string): string {
	const nonce = randomBytes(24)
	const sealed = xchacha20poly1305(key, nonce, encoder.encode(where)).encrypt(encoder.encode(plain))
	return PREFIX + base64url(concat(nonce, sealed))
}

export function open(key: Uint8Array, where: string, value: string): string {
	const bytes = fromBase64url(value.slice(PREFIX.length))
	try {
		return decoder.decode(xchacha20poly1305(key, bytes.subarray(0, 24), encoder.encode(where)).decrypt(bytes.subarray(24)))
	}
	catch {
		throw new Error(`A value could not be decrypted (${where}): another key, or not its place`)
	}
}

export const normalize = (value: string): string => value.toLowerCase().replace(/\s+/g, '')

export function blindIndex(key: Uint8Array, scope: string, value: string): string {
	return base64url(hmac(sha256, key, encoder.encode(`${scope}\u0000${normalize(value)}`)).subarray(0, 16))
}

/** A UUID v7 (time-ordered, like the server's): a new document's id, chosen before it is sealed. */
export function uuidv7(): string {
	const bytes = randomBytes(16)
	const ms = Date.now()
	for (let i = 0; i < 6; i++) bytes[i] = Math.floor(ms / 2 ** (8 * (5 - i))) & 0xff
	bytes[6] = (bytes[6] & 0x0f) | 0x70
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let at = 0
	for (const part of parts) {
		out.set(part, at)
		at += part.length
	}
	return out
}

export function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const b of bytes) binary += String.fromCharCode(b)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(text: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('Not base64url')
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - text.length % 4) % 4))
	return Uint8Array.from(binary, c => c.charCodeAt(0))
}

// --- the recovery key: the data key itself, to write down (Crockford's base32, groups of 4) ---

const BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function recoveryCode(key: Uint8Array): string {
	let bits = 0, value = 0, out = ''
	for (const byte of key) {
		value = (value << 8) | byte
		bits += 8
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31]
			bits -= 5
		}
	}
	if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
	return out.match(/.{1,4}/g)!.join('-')
}

export function fromRecoveryCode(code: string): Uint8Array {
	const clean = code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
	if (clean.length !== 52 || [...clean].some(c => !BASE32.includes(c))) throw new Error('Not a recovery key (52 characters)')
	const out: number[] = []
	let bits = 0, value = 0
	for (const c of clean) {
		value = (value << 5) | BASE32.indexOf(c)
		bits += 5
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff)
			bits -= 8
		}
	}
	return Uint8Array.from(out.slice(0, 32))
}
