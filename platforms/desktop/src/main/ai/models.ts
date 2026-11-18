import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream, createWriteStream, existsSync, promises as fsp, readFileSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { hubbyDeclarations } from '../hubbies/manager'
import { engineBinary } from './component'
import { parseDevices, pickDevice } from './engine'

/**
 * The AI models on this device (client docs/plan-ia-moteur.md § 5, docs/plan-ia.md D4): the ones the
 * hubbies declare (their hubby.json "ai", read from the copy checked at install — never from what a
 * renderer says), each file pinned (a Hugging Face repo at a commit, its sha256, its size).
 * - the device's fit: each variant against the dedicated GPU's memory, the RAM, the free disk; the
 *   first that runs well is the one used (the declared order is the hubby's preference);
 * - downloaded straight from huggingface.co (neither the server nor the VPN), resumed after a cut,
 *   its sha256 checked as it comes; kept ONCE per device, by its sha256, whoever declares it;
 * - only once the user agreed, on this device (the Models screen; the first use: ai.chat, phase 3).
 */

export type Family = 'text' | 'image' | 'voice'
export interface ModelFile { path: string, sha256: string, size: number }
export interface ModelVariant { repo: string, revision: string, files: ModelFile[], requires?: { vram?: number, ram?: number } }
export interface ModelDeclaration { family: Family, description?: string, variants: ModelVariant[] }

/** runs: as it should (on the GPU when it asks one); slow: only on the CPU; cannot: too big here */
export type Fit = 'runs' | 'slow' | 'cannot'

export interface DeviceInfo {
	ramMib: number
	gpu: { label: string, vramMib: number } | null
	freeDiskMib: number
	directory: string
}

export interface VariantPlan { repo: string, revision: string, sizeBytes: number, fit: Fit, reason: string, installed: boolean }

export interface ModelPlan {
	hubby: string
	hubbyLabel: string
	name: string
	family: Family
	description: string | null
	variants: VariantPlan[]
	/** the variant this device uses (index in `variants`), null: none can run here */
	chosen: number | null
	/** the user agreed to it on this device */
	consented: boolean
	/** its chosen variant is here */
	installed: boolean
	/** downloading now: bytes received, total */
	download: { received: number, total: number } | null
	/** the declaration is refused (not pinned as it must be) */
	invalid: string | null
}

export interface InstalledModel { sha256: string, repo: string, revision: string, path: string, sizeBytes: number, users: string[] }

interface StoredFile { repo: string, revision: string, path: string, size: number, file: string, users: string[] }
interface Index { directory: string | null, files: Record<string, StoredFile>, consents: Record<string, string> }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const COMMIT = /^[0-9a-f]{40}$/
const SHA256 = /^[0-9a-f]{64}$/
const PATH = /^(?!.*\.\.)[A-Za-z0-9._-]{1,120}(\/[A-Za-z0-9._-]{1,120}){0,3}$/
/** disk kept free besides a model */
const DISK_MARGIN_MIB = 2_048

const MIB = 2 ** 20
const indexFile = (): string => path.join(app.getPath('userData'), 'ai-models.json')
const defaultDirectory = (): string => path.join(app.getPath('userData'), 'models')

function readIndex(): Index {
	try {
		const raw = JSON.parse(readFileSync(indexFile(), 'utf8')) as Partial<Index>
		return { directory: raw.directory ?? null, files: raw.files ?? {}, consents: raw.consents ?? {} }
	}
	catch {
		return { directory: null, files: {}, consents: {} }
	}
}

function writeIndex(index: Index): void {
	writeFileSync(indexFile(), JSON.stringify(index, null, '\t'))
}

const directory = (index = readIndex()): string => index.directory ?? defaultDirectory()

/** A declaration as a device accepts it, else why not (the same rules as hubby-cli's checkAi). */
export function validDeclaration(model: unknown): { model: ModelDeclaration } | { error: string } {
	const m = model as Partial<ModelDeclaration> | null
	if (!m || typeof m !== 'object' || !['text', 'image', 'voice'].includes(m.family as string)) return { error: 'no family' }
	if (!Array.isArray(m.variants) || m.variants.length === 0) return { error: 'no variant' }
	for (const v of m.variants) {
		if (!v || !REPO.test(v.repo ?? '') || !COMMIT.test(v.revision ?? '')) return { error: 'a variant is not pinned to a commit' }
		if (!Array.isArray(v.files) || v.files.length === 0) return { error: 'a variant has no file' }
		for (const f of v.files) {
			if (!f || !PATH.test(f.path ?? '') || !SHA256.test(f.sha256 ?? '') || !Number.isInteger(f.size) || f.size <= 0) return { error: 'a file is not pinned (path, sha256, size)' }
		}
	}
	return { model: m as ModelDeclaration }
}

/** The GPU llama.cpp would use (the engine's listing; without the engine yet: nvidia-smi), null: none known. */
function readGpu(): Promise<{ label: string, vramMib: number } | null> {
	const binary = engineBinary('llama-server')
	return new Promise(resolve => {
		if (binary) {
			execFile(binary, ['--list-devices'], { timeout: 20_000 }, (_err, stdout, stderr) => {
				const d = pickDevice(parseDevices(`${stdout}\n${stderr}`))
				resolve(d?.dedicated ? { label: d.label, vramMib: d.mib } : null)
			})
			return
		}
		execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 5_000 }, (err, stdout) => {
			const [label, mib] = (stdout.split('\n')[0] ?? '').split(',').map(s => s.trim())
			resolve(err || !Number(mib) ? null : { label, vramMib: Number(mib) })
		})
	})
}

let gpuInfo: Promise<{ label: string, vramMib: number } | null> | null = null

export async function deviceInfo(): Promise<DeviceInfo> {
	const dir = directory()
	await fsp.mkdir(dir, { recursive: true })
	const disk = await fsp.statfs(dir)
	gpuInfo ??= readGpu()
	return { ramMib: Math.round(os.totalmem() / MIB), gpu: await gpuInfo, freeDiskMib: Math.floor((disk.bavail * disk.bsize) / MIB), directory: dir }
}

/** How a variant fits this device. */
export function fitOf(variant: ModelVariant, device: DeviceInfo, installed: boolean): { fit: Fit, reason: string } {
	const sizeMib = variant.files.reduce((n, f) => n + f.size, 0) / MIB
	if (!installed && device.freeDiskMib < sizeMib + DISK_MARGIN_MIB) return { fit: 'cannot', reason: `needs ${Math.ceil(sizeMib / 1024)} GB of disk, ${Math.floor(device.freeDiskMib / 1024)} GB free` }
	const ram = variant.requires?.ram ?? Math.ceil(sizeMib * 1.2)
	const vram = variant.requires?.vram
	if (vram && device.gpu && device.gpu.vramMib >= vram) return { fit: 'runs', reason: `on the GPU (${device.gpu.label})` }
	if (device.ramMib >= ram) return vram ? { fit: 'slow', reason: device.gpu ? `the GPU has ${device.gpu.vramMib} MiB of the ${vram} it needs: on the CPU, slower` : 'no dedicated GPU: on the CPU, slower' } : { fit: 'runs', reason: 'on the CPU' }
	return { fit: 'cannot', reason: `needs ${ram} MiB of RAM, this device has ${device.ramMib}` }
}

const key = (hubby: string, name: string): string => `${hubby}/${name}`
const variantKey = (v: { repo: string, revision: string }): string => `${v.repo}@${v.revision}`

function present(index: Index, f: ModelFile): boolean {
	const stored = index.files[f.sha256]
	if (!stored || !existsSync(stored.file)) return false
	try { return statSync(stored.file).size === f.size }
	catch { return false }
}

const downloads = new Map<string, { received: number, total: number, done: Promise<void> }>()
export const modelEvents = new EventEmitter()

/** Every model the hubbies declare, as this device sees it. */
export async function modelPlans(): Promise<ModelPlan[]> {
	const device = await deviceInfo()
	const index = readIndex()
	const plans: ModelPlan[] = []
	for (const hubby of hubbyDeclarations()) {
		const ai = hubby.ai as Record<string, unknown> | undefined
		if (!ai || typeof ai !== 'object') continue
		for (const [name, raw] of Object.entries(ai)) {
			if (!NAME.test(name)) continue
			const checked = validDeclaration(raw)
			const label = typeof hubby.label === 'string' ? hubby.label : hubby.id
			if ('error' in checked) {
				plans.push({ hubby: hubby.id, hubbyLabel: label, name, family: (raw as { family?: Family }).family ?? 'text', description: null, variants: [], chosen: null, consented: false, installed: false, download: null, invalid: checked.error })
				continue
			}
			const model = checked.model
			const variants = model.variants.map(v => {
				const installed = v.files.every(f => present(index, f))
				return { repo: v.repo, revision: v.revision, sizeBytes: v.files.reduce((n, f) => n + f.size, 0), installed, ...fitOf(v, device, installed) }
			})
			const runs = variants.findIndex(v => v.fit === 'runs')
			const chosen = runs >= 0 ? runs : variants.findIndex(v => v.fit === 'slow')
			const consent = index.consents[key(hubby.id, name)]
			const pick = chosen >= 0 ? model.variants[chosen] : null
			const dl = pick ? downloads.get(variantKey(pick)) : undefined
			plans.push({
				hubby: hubby.id, hubbyLabel: label, name, family: model.family, description: model.description ?? null, variants,
				chosen: chosen >= 0 ? chosen : null,
				consented: !!pick && consent === variantKey(pick),
				installed: chosen >= 0 && variants[chosen].installed,
				download: dl ? { received: dl.received, total: dl.total } : null,
				invalid: null
			})
		}
	}
	return plans
}

function declaration(hubby: string, name: string): ModelDeclaration {
	const found = hubbyDeclarations().find(h => h.id === hubby)?.ai as Record<string, unknown> | undefined
	const checked = validDeclaration(found?.[name])
	if ('error' in checked) throw new Error(`${hubby} declares no model ${name} this device accepts`)
	return checked.model
}

async function sha256Of(file: string, hash = createHash('sha256')): Promise<ReturnType<typeof createHash>> {
	for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
	return hash
}

/** One file, by its sha256: resumed from what is already here, checked, then in place. */
async function fetchFile(variant: ModelVariant, f: ModelFile, dir: string, onBytes: (n: number) => void): Promise<string> {
	const final = path.join(dir, f.sha256, path.basename(f.path))
	const part = path.join(dir, f.sha256, `${path.basename(f.path)}.part`)
	await fsp.mkdir(path.dirname(final), { recursive: true })
	let have = existsSync(part) ? statSync(part).size : 0
	if (have > f.size) { await fsp.rm(part); have = 0 }
	const hash = have ? await sha256Of(part) : createHash('sha256')
	onBytes(have)
	if (have < f.size) {
		const url = `https://huggingface.co/${variant.repo}/resolve/${variant.revision}/${f.path.split('/').map(encodeURIComponent).join('/')}`
		const res = await net.fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} })
		if (!(res.ok || res.status === 206) || !res.body) throw new Error(`HTTP ${res.status} for ${f.path}`)
		if (have && res.status !== 206) throw new Error('the server did not resume the download')
		const out = createWriteStream(part, { flags: have ? 'a' : 'w' })
		const reader = res.body.getReader()
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break
				hash.update(value)
				if (!out.write(value)) await new Promise(resolve => out.once('drain', resolve))
				onBytes(value.length)
			}
		}
		finally {
			await new Promise<void>(resolve => out.end(resolve))
		}
	}
	const sum = hash.digest('hex')
	if (sum !== f.sha256) {
		await fsp.rm(part, { force: true })
		throw new Error(`${f.path}: sha256 ${sum}, expected ${f.sha256}`)
	}
	await fsp.rename(part, final)
	return final
}

/**
 * The user agreed (this device): the hubby's model `name` in the variant that fits, downloaded if it
 * isn't here. Resolves once it is here; progress on modelEvents ('changed').
 */
export async function downloadModel(hubby: string, name: string): Promise<void> {
	const model = declaration(hubby, name)
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === name)
	if (!plan || plan.chosen === null) throw new Error(`${hubby} ${name}: no variant can run on this device`)
	const variant = model.variants[plan.chosen]
	const index = readIndex()
	index.consents[key(hubby, name)] = variantKey(variant)
	writeIndex(index)
	const k = variantKey(variant)
	const running = downloads.get(k)
	if (running) return running.done
	const state = { received: 0, total: variant.files.reduce((n, f) => n + f.size, 0), done: Promise.resolve() }
	let last = 0
	const tick = (n: number) => {
		state.received += n
		if (Date.now() - last > 500) { last = Date.now(); modelEvents.emit('changed') }
	}
	state.done = (async () => {
		try {
			const dir = directory()
			for (const f of variant.files) {
				const now = readIndex()
				if (present(now, f)) { tick(f.size); continue }
				const file = await fetchFile(variant, f, dir, tick)
				const after = readIndex()
				after.files[f.sha256] = { repo: variant.repo, revision: variant.revision, path: f.path, size: f.size, file, users: [...new Set([...(after.files[f.sha256]?.users ?? []), key(hubby, name)])] }
				writeIndex(after)
				console.log(`[ai:models] ${variant.repo} ${f.path} installed (${(f.size / 2 ** 30).toFixed(2)} GiB, sha256 checked)`)
			}
			const after = readIndex()
			for (const f of variant.files) {
				const s = after.files[f.sha256]
				if (s && !s.users.includes(key(hubby, name))) s.users.push(key(hubby, name))
			}
			writeIndex(after)
		}
		finally {
			downloads.delete(k)
			modelEvents.emit('changed')
		}
	})()
	downloads.set(k, state)
	modelEvents.emit('changed')
	return state.done
}

export function installedModels(): InstalledModel[] {
	const index = readIndex()
	return Object.entries(index.files).filter(([, s]) => existsSync(s.file))
		.map(([sha256, s]) => ({ sha256, repo: s.repo, revision: s.revision, path: s.path, sizeBytes: s.size, users: s.users }))
}

/** Deletes a model's file from this device (the hubbies using it will ask again). */
export async function removeModel(sha256: string): Promise<void> {
	if (!SHA256.test(sha256)) throw new Error('invalid model')
	const index = readIndex()
	const stored = index.files[sha256]
	if (!stored) return
	await fsp.rm(path.dirname(stored.file), { recursive: true, force: true })
	delete index.files[sha256]
	for (const [k, v] of Object.entries(index.consents)) if (v === variantKey(stored)) delete index.consents[k]
	writeIndex(index)
	console.log(`[ai:models] ${stored.repo} ${stored.path} removed`)
	modelEvents.emit('changed')
}

/** Where new models go (the ones here stay where they are). */
export function setModelsDirectory(dir: string): void {
	const index = readIndex()
	index.directory = dir
	writeIndex(index)
	modelEvents.emit('changed')
}

/** The files of the hubby's model `name` on this device, if the user agreed and it is here (the engine runs them). */
export function modelFiles(hubby: string, name: string): string[] | null {
	const model = declaration(hubby, name)
	const index = readIndex()
	const agreed = index.consents[key(hubby, name)]
	const variant = model.variants.find(v => variantKey(v) === agreed)
	if (!variant || !variant.files.every(f => present(index, f))) return null
	return variant.files.map(f => index.files[f.sha256].file)
}
