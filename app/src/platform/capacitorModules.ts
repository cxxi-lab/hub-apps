import { registerPlugin } from '@capacitor/core'
import { RELEASES_URL, verifySignature } from './capacitorUpdater'
import type { ModulePackage, ModuleStoreApi, PublisherCertificate, RestrictedModulePackage } from './types'

// The modules on Android, the twin of the desktop's (desktop/src/main/modules/manager.ts): the
// catalogue of published modules (the server's module registry, each entry signed alone by CI with
// the app updates' key) is fetched and verified here, then handed to the native side, which downloads a module
// (newest version compatible with this APK, every file checked against the catalogue), serves it
// at once when it is installed, and its newer versions from the next start
// (mobile/android/.../ModuleStore.java). The restricted modules (offered only to the accounts given
// them) come from the server's list instead (setRestricted): each entry signed alone, with a signed
// URL per file; this device's native files only (ModuleStore filters by platform).

const MODULES_URL = `${RELEASES_URL}modules/`
const CHECK_EVERY_MS = 30 * 60_000
/** The last catalogue read (its signature checked then), for when the server is out of reach. */
const LAST_CATALOG = 'hub:modules:catalog'

interface PublishedEntry extends ModulePackage {
	files: { path: string; sha256: string; platform?: string }[]
	/** a restricted module's files' signed URLs */
	urls?: Record<string, string>
}

/** The restricted modules' signed entries, as last listed (for when the server is out of reach). */
const LAST_RESTRICTED = 'hub:modules:restricted'
/** id → a restricted module's entry (signature checked), with its files' URLs */
let restricted = new Map<string, PublishedEntry>()
/** whether the server listed them this session: until then nothing is dropped as unpublished */
let restrictedListed = false

const base64 = (value: string): ArrayBuffer => Uint8Array.from(atob(value), c => c.charCodeAt(0)).buffer as ArrayBuffer
const utf8 = (value: string): ArrayBuffer => new TextEncoder().encode(value).buffer as ArrayBuffer

/**
 * Whether an entry is signed: by the update key, or by its publisher's key, which the update key
 * certified for that module only.
 */
async function signedEntry(entry: string, signature: string, publisher?: PublisherCertificate): Promise<boolean> {
	if (await verifySignature(utf8(entry), base64(signature))) return true
	if (!publisher || !(await verifySignature(utf8(publisher.certificate), base64(publisher.signature)))) return false
	try {
		const certificate = JSON.parse(publisher.certificate) as { module?: unknown, key?: unknown }
		if (typeof certificate.key !== 'string' || certificate.module !== (JSON.parse(entry) as { id?: unknown }).id) return false
		return await verifySignature(utf8(entry), base64(signature), base64(certificate.key))
	}
	catch {
		return false
	}
}

/** A restricted module's entry if it matches its signature, else null. */
async function trusted(module: RestrictedModulePackage): Promise<PublishedEntry | null> {
	if (!(await signedEntry(module.entry, module.signature, module.publisher))) return null
	try {
		const entry = JSON.parse(module.entry) as PublishedEntry
		return typeof entry?.id === 'string' && Array.isArray(entry.files) ? { ...entry, urls: module.urls ?? {} } : null
	}
	catch {
		return null
	}
}

/** The last restricted list, signatures checked again, until the server lists them this session. */
async function lastRestricted(): Promise<void> {
	try {
		const kept = JSON.parse(localStorage.getItem(LAST_RESTRICTED) ?? '[]') as RestrictedModulePackage[]
		for (const module of Array.isArray(kept) ? kept : []) {
			const entry = await trusted(module)
			if (entry && !restricted.has(entry.id)) restricted.set(entry.id, entry)
		}
	}
	catch {
		// none kept
	}
}
const restoring = lastRestricted()

interface ModulesPlugin {
	getState(): Promise<{ sdk: string; running: Record<string, string>; modules: ModulePackage[] }>
	install(options: { id: string; entry?: PublishedEntry; baseUrl?: string }): Promise<ModulePackage>
	uninstall(options: { id: string }): Promise<void>
	/** drop: remove the modules no longer published (only once the restricted ones are listed) */
	update(options: { catalog: unknown[]; baseUrl: string; drop: boolean }): Promise<{ downloaded: string[] }>
	pending(): Promise<{ pending: string[] }>
	activate(): Promise<{ activated: string[] }>
}

const Modules = registerPlugin<ModulesPlugin>('Modules')

/** The server's module registry: each published module's entry, signed alone by CI (null: none usable). */
const REGISTRY_URL = new URL('/api/hub/modules/catalog', RELEASES_URL).href

async function registryCatalog(): Promise<PublishedEntry[] | null> {
	const res = await fetch(REGISTRY_URL, { cache: 'no-store' })
	if (!res.ok) return null
	const list = ((await res.json()) as { data?: unknown }).data
	if (!Array.isArray(list)) return null
	const entries: PublishedEntry[] = []
	for (const item of list as Array<{ entry?: unknown, signature?: unknown, publisher?: PublisherCertificate }>) {
		if (typeof item?.entry !== 'string' || typeof item?.signature !== 'string') continue
		if (!(await signedEntry(item.entry, item.signature, item.publisher))) {
			console.warn('[modules] a registry entry does not match its signature: ignored')
			continue
		}
		entries.push(JSON.parse(item.entry) as PublishedEntry)
	}
	return entries.length ? entries : null
}

/**
 * The published catalogue: the registry's signed entries (the server picks which are published,
 * a withdrawn module leaves); null when out of reach or not trusted (the last one read holds).
 */
async function remoteCatalog(): Promise<PublishedEntry[] | null> {
	const registry = await registryCatalog()
	if (!registry) return null
	try { localStorage.setItem(LAST_CATALOG, JSON.stringify(registry)) } catch { /* read again next time */ }
	return registry
}

/** A catalogue read this recently is used again (several modules installed in a row). */
const FRESH_FOR_MS = 60_000
let recent: { at: number; entries: PublishedEntry[] } | null = null

/** The published catalogue: fresh, else the last one read. */
async function publishedCatalog(): Promise<PublishedEntry[]> {
	await restoring
	return [...await offeredCatalog(), ...restricted.values()]
}

async function offeredCatalog(): Promise<PublishedEntry[]> {
	if (recent && Date.now() - recent.at < FRESH_FOR_MS) return recent.entries
	const fresh = await remoteCatalog().catch(err => {
		console.warn('[modules] catalogue out of reach', err)
		return null
	})
	if (fresh) {
		recent = { at: Date.now(), entries: fresh }
		return fresh
	}
	try {
		const kept = JSON.parse(localStorage.getItem(LAST_CATALOG) ?? '[]') as unknown
		return Array.isArray(kept) ? kept as PublishedEntry[] : []
	}
	catch {
		return []
	}
}

// Plain x.y.z versions and ^x.y.z ranges, as the native side reads them (ModuleStore).
function parts(version: string): number[] {
	return version.split('.').map(n => Number.parseInt(n, 10) || 0)
}

function compare(a: string, b: string): number {
	const [x, y] = [parts(a), parts(b)]
	return (x[0] - y[0]) || (x[1] - y[1]) || (x[2] - y[2])
}

function satisfiesOne(version: string, range: string): boolean {
	if (!range.startsWith('^')) return compare(version, range) === 0
	const base = range.slice(1)
	const [major, minor] = parts(base)
	const [vMajor, vMinor] = parts(version)
	if (compare(version, base) < 0) return false
	return major > 0 ? vMajor === major : vMajor === 0 && vMinor === minor
}

function satisfies(version: string, range: string): boolean {
	// alternatives (`^1.12.0 || ^2.0.0`): a module running on two majors of the SDK
	return range.split('||').some(part => satisfiesOne(version, part.trim()))
}

/** The newest published version of each module this APK can run. */
function compatible(published: PublishedEntry[], sdk: string): Map<string, PublishedEntry> {
	const newest = new Map<string, PublishedEntry>()
	for (const entry of published) {
		if (typeof entry?.id !== 'string' || typeof entry.version !== 'string' || typeof entry.sdk !== 'string') continue
		if (!satisfies(sdk, entry.sdk)) continue
		const known = newest.get(entry.id)
		if (!known || compare(entry.version, known.version) > 0) newest.set(entry.id, entry)
	}
	return newest
}

const installing = new Map<string, Promise<ModulePackage>>()

export function createModuleStore(): ModuleStoreApi {
	return {
		async list() {
			const [state, published] = await Promise.all([Modules.getState(), publishedCatalog()])
			const modules = new Map<string, ModulePackage>()
			for (const [id, { files: _files, ...entry }] of compatible(published, state.sdk)) modules.set(id, entry)
			for (const entry of state.modules) modules.set(entry.id, entry)
			return { modules: [...modules.values()], installed: state.modules.map(m => m.id) }
		},
		install(id) {
			let pending = installing.get(id)
			if (!pending) {
				pending = (async () => {
					const state = await Modules.getState()
					const running = state.modules.find(m => m.id === id)
					if (running) return running
					const entry = compatible(await publishedCatalog(), state.sdk).get(id)
					return Modules.install({ id, entry, baseUrl: MODULES_URL })
				})().finally(() => installing.delete(id))
				installing.set(id, pending)
			}
			return pending
		},
		uninstall: id => Modules.uninstall({ id }),
		pending: async () => (await Modules.pending()).pending,
		activate: async () => (await Modules.activate()).activated,
		async setRestricted(modules) {
			const next = new Map<string, PublishedEntry>()
			const kept: RestrictedModulePackage[] = []
			for (const module of modules) {
				const entry = await trusted(module)
				if (!entry) {
					console.warn('[modules] a restricted module does not match its signature: ignored')
					continue
				}
				next.set(entry.id, entry)
				kept.push({ entry: module.entry, signature: module.signature, urls: {}, publisher: module.publisher })
			}
			restricted = next
			restrictedListed = true
			try { localStorage.setItem(LAST_RESTRICTED, JSON.stringify(kept)) } catch { /* listed again next time */ }
			await checkModuleUpdates()
		}
	}
}

let checking = false

/** Downloads the newer versions of the installed modules (next start). True once the catalogue was read. */
export async function checkModuleUpdates(): Promise<boolean> {
	if (checking) return true
	checking = true
	try {
		const offered = await remoteCatalog()
		if (!offered) return false
		await restoring
		const catalog = [...offered, ...restricted.values()]
		const { downloaded } = await Modules.update({ catalog, baseUrl: MODULES_URL, drop: restrictedListed })
		if (downloaded.length) console.info('[modules] downloaded, used from the next start:', downloaded.join(', '))
		return true
	}
	catch (err) {
		console.warn('[modules] update check failed', err)
		return false
	}
	finally {
		checking = false
	}
}

/** The periodic check (the first one at start, see capacitor.ts). */
export function startModuleUpdates(): void {
	setInterval(() => void checkModuleUpdates(), CHECK_EVERY_MS)
}
