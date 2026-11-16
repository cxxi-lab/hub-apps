import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deriveKeys, newDataKey, concat } from './format'
import { BLOCK, HEADER, openFile, openRange, openStream, plainSize, sealedSize, sealFile, sealStream } from './files'

// The f1 format (files.ts): run with npm run test:crypto
const key = deriveKeys(newDataKey()).files
const where = 'storage/lab/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const SEALED_BLOCK = BLOCK + 16
/** Random bytes of any size (crypto.getRandomValues stops at 64 KiB a call). */
function randomBytes(size: number): Uint8Array {
	const out = new Uint8Array(size)
	for (let at = 0; at < size; at += 65536) crypto.getRandomValues(out.subarray(at, Math.min(size, at + 65536)))
	return out
}
const sizes = [0, 1, 1000, BLOCK - 1, BLOCK, BLOCK + 1, 3 * BLOCK, 3 * BLOCK + 5]

async function pipe(stream: TransformStream<Uint8Array, Uint8Array>, input: Uint8Array, pieces: number[]): Promise<Uint8Array> {
	const writer = stream.writable.getWriter()
	const out: Uint8Array[] = []
	const reading = (async () => {
		const reader = stream.readable.getReader()
		for (;;) {
			const { done, value } = await reader.read()
			if (done) return
			out.push(value)
		}
	})()
	const writing = (async () => {
		let at = 0, p = 0
		while (at < input.length) {
			const n = pieces[p++ % pieces.length]
			await writer.write(input.slice(at, at + n))
			at += n
		}
		await writer.close()
	})()
	// both sides fail together when the stream errors: wait for both, report the first
	const [w, r] = await Promise.allSettled([writing, reading])
	if (r.status === 'rejected') throw r.reason
	if (w.status === 'rejected') throw w.reason
	return concat(...out)
}

test('a file comes back as it was, whatever its size', () => {
	for (const size of sizes) {
		const plain = randomBytes(size)
		const sealed = sealFile(key, where, plain)
		assert.equal(sealed.length, sealedSize(size), `size ${size}`)
		assert.equal(plainSize(sealed.length), size)
		assert.deepEqual(openFile(key, where, sealed), plain)
	}
})

test('streams: what one encrypts in pieces, the other decrypts, and both match the whole-file calls', async () => {
	for (const size of sizes) {
		const plain = randomBytes(size)
		const sealed = await pipe(sealStream(key, where), plain, [7, 70_000, 1, BLOCK])
		assert.equal(sealed.length, sealedSize(size))
		assert.deepEqual(openFile(key, where, sealed), plain)
		assert.deepEqual(await pipe(openStream(key, where), sealFile(key, where, plain), [5, 100_000, 33]), plain)
	}
})

test('a file cut short is refused, even at a block end, and so is data added after it', async () => {
	const sealed = sealFile(key, where, randomBytes(3 * BLOCK + 5))
	for (const cut of [HEADER + 2 * SEALED_BLOCK, HEADER + 2 * SEALED_BLOCK + 100, sealed.length - 1, HEADER, 10]) {
		assert.throws(() => openFile(key, where, sealed.subarray(0, cut)), /could not be decrypted/, `cut at ${cut}`)
		await assert.rejects(pipe(openStream(key, where), sealed.subarray(0, cut), [BLOCK]), /could not be decrypted/)
	}
	assert.throws(() => openFile(key, where, concat(sealed, new Uint8Array(20))), /could not be decrypted/)
})

test('blocks moved or repeated, a byte changed, another place or key: refused', () => {
	const sealed = sealFile(key, where, randomBytes(3 * BLOCK))
	const block = (i: number) => sealed.subarray(HEADER + i * SEALED_BLOCK, HEADER + (i + 1) * SEALED_BLOCK)
	const header = sealed.subarray(0, HEADER)
	assert.throws(() => openFile(key, where, concat(header, block(1), block(0), block(2))), /block 0/)
	assert.throws(() => openFile(key, where, concat(header, block(0), block(0), block(2))), /block 1/)
	const flipped = sealed.slice()
	flipped[HEADER + SEALED_BLOCK + 10] ^= 1
	assert.throws(() => openFile(key, where, flipped), /block 1/)
	const salt = sealed.slice()
	salt[5] ^= 1
	assert.throws(() => openFile(key, where, salt), /block 0/)
	assert.throws(() => openFile(key, 'storage/lab/another', sealed), /could not be decrypted/)
	assert.throws(() => openFile(deriveKeys(newDataKey()).files, where, sealed), /could not be decrypted/)
	assert.throws(() => openFile(key, where, concat(new Uint8Array([0x66, 0x32]), sealed.subarray(2))), /not an f1 file/)
})

test('a passage reads only its blocks, and gives the same bytes as the whole file', async () => {
	const size = 5 * BLOCK + 1234
	const plain = randomBytes(size)
	const sealed = sealFile(key, where, plain)
	const reads: Array<[number, number]> = []
	const read = async (from: number, to: number) => {
		reads.push([from, to])
		return sealed.slice(from, to)
	}
	const ranges: Array<[number, number]> = [[0, 1], [0, size], [BLOCK - 3, BLOCK + 3], [2 * BLOCK, 3 * BLOCK], [size - 10, size], [size - 10, size + 500], [4 * BLOCK + 7, 5 * BLOCK + 9]]
	for (const [start, end] of ranges) {
		reads.length = 0
		assert.deepEqual(await openRange(key, where, sealed.length, read, start, end), plain.subarray(start, Math.min(end, size)), `${start}-${end}`)
		const blocks = Math.floor((Math.min(end, size) - 1) / BLOCK) - Math.floor(start / BLOCK) + 1
		assert.ok(reads[1][1] - reads[1][0] <= blocks * SEALED_BLOCK, 'only the blocks needed')
	}
	assert.equal((await openRange(key, where, sealed.length, read, 10, 10)).length, 0)
	// the last block is still checked as the last one
	const empty = sealFile(key, where, new Uint8Array(0))
	assert.equal((await openRange(key, where, empty.length, async (f, t) => empty.slice(f, t), 0, 10)).length, 0)
})
