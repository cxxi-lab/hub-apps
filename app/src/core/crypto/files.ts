import { chacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { concat, randomBytes } from './format'

/**
 * The format of an encrypted file, `f1` (docs/plan-storage-capability.md § 3.3), made on the device
 * with the data key's files subkey before a file leaves it. Built in blocks, so that a large file is
 * encrypted and decrypted as a stream, and a passage is read without downloading the rest (music,
 * video):
 *
 *   header  'f1' ‖ salt (32 random bytes)
 *   blocks  ChaCha20-Poly1305 of 64 KiB of the file each (the last one shorter, or empty for an
 *           empty file), under the file's own key, nonce = block number (11 bytes, big-endian)
 *           ‖ 1 on the last block, 0 on the others
 *
 * - The file's key: HKDF-SHA256(files subkey, salt, `hub-files/<where>`). `where` is the file's
 *   place (`storage/<module>/<file id>`): an encrypted file copied onto another doesn't open.
 * - A block moved, removed or repeated doesn't open (its number is in its nonce); a file cut short,
 *   even at a block's end, is refused (its last block is marked); data added after it, too.
 * As age's payload (STREAM, Hoang, Reyhanitabar, Rogaway, Vizár).
 */

export const MAGIC = new Uint8Array([0x66, 0x31]) // 'f1'
export const BLOCK = 64 * 1024
const TAG = 16
const SALT = 32
export const HEADER = MAGIC.length + SALT
const SEALED_BLOCK = BLOCK + TAG
const encoder = new TextEncoder()

export class FileDecryptError extends Error {
	constructor(where: string, why: string) {
		super(`A file could not be decrypted (${where}): ${why}`)
	}
}

function fileKey(key: Uint8Array, where: string, salt: Uint8Array): Uint8Array {
	if (key.length !== 32) throw new Error('A files key is 32 bytes')
	return hkdf(sha256, key, salt, encoder.encode(`hub-files/${where}`), 32)
}

function nonce(block: number, last: boolean): Uint8Array {
	const n = new Uint8Array(12)
	let v = block
	for (let i = 10; i >= 0 && v > 0; i--) {
		n[i] = v % 256
		v = Math.floor(v / 256)
	}
	n[11] = last ? 1 : 0
	return n
}

/** The file's key, from its header (checked). */
function keyFromHeader(key: Uint8Array, where: string, header: Uint8Array): Uint8Array {
	if (header.length < HEADER || header[0] !== MAGIC[0] || header[1] !== MAGIC[1]) throw new FileDecryptError(where, 'not an f1 file')
	return fileKey(key, where, header.subarray(MAGIC.length, HEADER))
}

function openBlock(k: Uint8Array, where: string, block: number, sealed: Uint8Array, last: boolean): Uint8Array {
	try {
		return chacha20poly1305(k, nonce(block, last)).decrypt(sealed)
	}
	catch {
		throw new FileDecryptError(where, last ? `block ${block} is not the file's end (cut short, moved, or another key)` : `block ${block} is damaged, moved, or from another key`)
	}
}

// --- sizes ---

/** The size of a file once encrypted. */
export function sealedSize(plain: number): number {
	const blocks = Math.max(1, Math.ceil(plain / BLOCK))
	return HEADER + plain + blocks * TAG
}

/** The size of the file in an encrypted one (or an error if no f1 file has that size). */
export function plainSize(sealed: number): number {
	const body = sealed - HEADER
	const blocks = Math.ceil(body / SEALED_BLOCK)
	const last = body - (blocks - 1) * SEALED_BLOCK
	if (body < TAG || last < TAG) throw new Error('Not the size of an f1 file')
	return body - blocks * TAG
}

// --- whole files ---

export function sealFile(key: Uint8Array, where: string, plain: Uint8Array): Uint8Array {
	const salt = randomBytes(SALT)
	const k = fileKey(key, where, salt)
	const blocks = Math.max(1, Math.ceil(plain.length / BLOCK))
	const parts: Uint8Array[] = [MAGIC, salt]
	for (let i = 0; i < blocks; i++) {
		parts.push(chacha20poly1305(k, nonce(i, i === blocks - 1)).encrypt(plain.subarray(i * BLOCK, (i + 1) * BLOCK)))
	}
	return concat(...parts)
}

export function openFile(key: Uint8Array, where: string, sealed: Uint8Array): Uint8Array {
	const k = keyFromHeader(key, where, sealed)
	const body = sealed.subarray(HEADER)
	if (body.length < TAG) throw new FileDecryptError(where, 'cut short')
	const blocks = Math.ceil(body.length / SEALED_BLOCK)
	const parts: Uint8Array[] = []
	for (let i = 0; i < blocks; i++) {
		parts.push(openBlock(k, where, i, body.subarray(i * SEALED_BLOCK, (i + 1) * SEALED_BLOCK), i === blocks - 1))
	}
	return concat(...parts)
}

// --- streams ---

/** Encrypts as it reads: plain bytes in, an f1 file out (header first, then each full block). */
export function sealStream(key: Uint8Array, where: string): TransformStream<Uint8Array, Uint8Array> {
	const salt = randomBytes(SALT)
	const k = fileKey(key, where, salt)
	let pending: Uint8Array = new Uint8Array(0)
	let block = 0
	return new TransformStream({
		start(controller) {
			controller.enqueue(concat(MAGIC, salt))
		},
		transform(chunk, controller) {
			pending = concat(pending, chunk)
			// a full block is sent only once more comes after it: the last one is kept for the end
			while (pending.length > BLOCK) {
				controller.enqueue(chacha20poly1305(k, nonce(block++, false)).encrypt(pending.subarray(0, BLOCK)))
				pending = pending.slice(BLOCK)
			}
		},
		flush(controller) {
			controller.enqueue(chacha20poly1305(k, nonce(block, true)).encrypt(pending))
		},
	})
}

/** Decrypts as it reads: an f1 file in, its bytes out; errors on a damaged or cut short file. */
export function openStream(key: Uint8Array, where: string): TransformStream<Uint8Array, Uint8Array> {
	let k: Uint8Array | null = null
	let pending: Uint8Array = new Uint8Array(0)
	let block = 0
	return new TransformStream({
		transform(chunk, controller) {
			pending = concat(pending, chunk)
			if (!k) {
				if (pending.length < HEADER) return
				k = keyFromHeader(key, where, pending)
				pending = pending.slice(HEADER)
			}
			while (pending.length > SEALED_BLOCK) {
				controller.enqueue(openBlock(k, where, block++, pending.subarray(0, SEALED_BLOCK), false))
				pending = pending.slice(SEALED_BLOCK)
			}
		},
		flush(controller) {
			if (!k || pending.length < TAG) throw new FileDecryptError(where, 'cut short')
			controller.enqueue(openBlock(k, where, block, pending, true))
		},
	})
}

// --- a passage ---

/**
 * Bytes [start, end) of the file in an encrypted one of `sealed` bytes, reading only the blocks
 * that hold them: `read(from, to)` returns the encrypted bytes [from, to) (an HTTP Range request).
 */
export async function openRange(
	key: Uint8Array,
	where: string,
	sealed: number,
	read: (from: number, to: number) => Promise<Uint8Array>,
	start: number,
	end: number,
): Promise<Uint8Array> {
	const size = plainSize(sealed)
	end = Math.min(end, size)
	if (start < 0 || start >= end) return new Uint8Array(0)
	const k = keyFromHeader(key, where, await read(0, HEADER))
	const lastBlock = Math.max(1, Math.ceil(size / BLOCK)) - 1
	const first = Math.floor(start / BLOCK)
	const final = Math.floor((end - 1) / BLOCK)
	const from = HEADER + first * SEALED_BLOCK
	const bytes = await read(from, Math.min(sealed, HEADER + (final + 1) * SEALED_BLOCK))
	const parts: Uint8Array[] = []
	for (let i = first; i <= final; i++) {
		const at = (i - first) * SEALED_BLOCK
		parts.push(openBlock(k, where, i, bytes.subarray(at, at + SEALED_BLOCK), i === lastBlock))
	}
	const plain = concat(...parts)
	return plain.subarray(start - first * BLOCK, end - first * BLOCK)
}
