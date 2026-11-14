import { app, ipcMain, net, protocol } from 'electron'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sdk from '@cxxi-lab/hub-sdk/version.json'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../network/updateSigningKey'
import { fetchBuffer, RELEASES_URL } from '../network/updater'
import { registerNativeLookup } from './natives'
import { compareVersions, satisfies } from './semver'
import { HUBBY_SCHEME } from '../app/schemes'

/**
 * The modules of this device, apart from the app (see app/scripts/build-modules.mjs):
 *  - the server's module registry lists every published module (/api/hub/modules/catalog), each
 *    entry signed alone by CI with the update key: the server picks what is published, it can't
 *    forge an entry;
 *  - a module is installed on demand (enabled, see the app's core/module/registry): its newest
 *    version compatible with this app's SDK is downloaded into userData/modules/<id>/<version>/,
 *    every file checked against the signed catalogue, and usable at once;
 *  - an installed module's newer versions are downloaded in the background, and the version each
 *    one runs is decided once, at start (no half-updated session);
 *  - a build may still ship modules (out/renderer/modules/<id>, a build run from the sources): a
 *    downloaded newer copy wins over them.
 *  - the restricted modules (offered only to the accounts given them) are not in that catalogue: the
 *    renderer hands their entries over (setRestricted, from the server's authenticated list), each
 *    signed alone with the same key, with signed URLs for their files;
 *  - a module's native files (native/<platform>/…, e.g. the VPN's wireproxy for Private) come with
 *    it, this platform's only, and stay here (nativeFile), never served to the renderer.
 * The renderer loads modules/<id>/… at the app's own address, whichever copy it is (the file
 * protocol is answered here): their relative imports of shared/*.js reach the app's files, so
 * there is one React, one SDK.
 */

/** A catalogue entry (ModulePackage in the app): id, version, sdk range, css, and its description. */
interface ModuleEntry {
	id: string
	version: string
	sdk: string
	css: boolean
	[field: string]: unknown
}

interface RemoteEntry extends ModuleEntry {
	/** `platform`: a native file, only for that platform */
	files: { path: string, sha256: string, platform?: string }[]
}

/** A restricted module handed over by the renderer: its signed entry, and where to get each file. */
interface RestrictedModule {
	entry: string
	/** base64 */
	signature: string
	urls?: Record<string, string>
	/** signed by its publisher's key: that key's certificate (see signedEntry) */
	publisher?: Publisher
}

/** A key allowed to sign one module's entries: {"module", "key" (SPKI DER, base64)}, certified by the update key. */
interface Publisher {
	certificate: string
	signature: string
}

/**
 * Whether an entry is signed: by the update key, or by its publisher's key, which the update key
 * certified for that module only (a third party's module).
 */
function signedEntry(entry: string, signature: string, publisher?: Publisher): boolean {
	const body = Buffer.from(entry, 'utf8')
	const sig = Buffer.from(signature, 'base64')
	if (verify(null, body, PUBLIC_KEY, sig)) return true
	if (!publisher || typeof publisher.certificate !== 'string' || typeof publisher.signature !== 'string') return false
	if (!verify(null, Buffer.from(publisher.certificate, 'utf8'), PUBLIC_KEY, Buffer.from(publisher.signature, 'base64'))) return false
	try {
		const certificate = JSON.parse(publisher.certificate) as { module?: unknown, key?: unknown }
		if (typeof certificate.key !== 'string' || certificate.module !== (JSON.parse(entry) as { id?: unknown }).id) return false
		return verify(null, body, createPublicKey({ key: Buffer.from(certificate.key, 'base64'), format: 'der', type: 'spki' }), sig)
	}
	catch {
		return false
	}
}

interface Active extends ModuleEntry {
	/** the downloaded copy's folder; null: the one the build ships */
	dir: string | null
}

const RENDERER = join(__dirname, '../renderer')
const BUILT_IN = join(RENDERER, 'modules')

// The isolated hubbies' frames load from hubby://<id>/ (HUBBY_SCHEME, declared in app/schemes).
const RUNTIME = join(RENDERER, 'hubby-runtime')
const RUNTIME_PATH = /^chunks\/[A-Za-z0-9._-]{1,120}$|^[A-Za-z0-9._-]{1,80}$/
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css', html: 'text/html', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', woff2: 'font/woff2' }
const ID = /^[a-z0-9-]{1,40}$/
const VERSION = /^\d+\.\d+\.\d+$/
const FILE = /^[A-Za-z0-9._-]{1,80}$/
/** a published file: a bundle file, or a native one (native/<platform>/<name>) */
const PUBLISHED_FILE = /^[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80}){0,2}$/
/** this machine, as the native files are tagged */
const PLATFORM = `${process.platform}-${process.arch}`
/**
 * Builds run from the sources only (never an installed app): a local release folder and its key,
 * to try module updates end to end without publishing (HUB_MODULES_URL, its registry.json in the
 * registry's format, HUB_MODULES_PUBLIC_KEY, HUB_MODULES_STORE).
 */
const TESTING = !app.isPackaged && !!process.env['HUB_MODULES_URL']
const MODULES_URL = TESTING ? process.env['HUB_MODULES_URL']!.replace(/\/?$/, '/') : `${RELEASES_URL}modules/`
const PUBLIC_KEY = TESTING && process.env['HUB_MODULES_PUBLIC_KEY'] ? readFileSync(process.env['HUB_MODULES_PUBLIC_KEY'], 'utf8') : UPDATE_SIGNING_PUBLIC_KEY
// (a test keeps its downloads apart too: a source build shares its profile folder with the installed app)
const STORE = TESTING && process.env['HUB_MODULES_STORE'] ? process.env['HUB_MODULES_STORE'] : join(app.getPath('userData'), 'modules')
/** The last published catalogue read (its signature checked then), for when the server is out of reach. */
const LAST_CATALOG = join(STORE, 'catalog.json')

/** The restricted modules' signed entries, as last handed over (for when the server is out of reach). */
const RESTRICTED = join(STORE, 'restricted')

/** Look for module updates this often, besides at start. */
const CHECK_EVERY_MS = 30 * 60_000

/** id → the version running this session, decided at start (or at its install). */
let active = new Map<string, Active>()

/** The modules the build ships (a release ships none: they are installed from the server). */
function builtIns(): ModuleEntry[] {
	try {
		const entries = JSON.parse(readFileSync(join(BUILT_IN, 'catalog.json'), 'utf8')) as ModuleEntry[]
		return entries.filter(e => existsSync(join(BUILT_IN, e.id, 'index.js')))
	}
	catch {
		return []
	}
}

/** The downloaded versions of a module, complete ones only (a download lands in place once checked). */
function downloaded(id: string): ModuleEntry[] {
	const dir = join(STORE, id)
	if (!existsSync(dir)) return []
	return readdirSync(dir).filter(v => VERSION.test(v)).flatMap(version => {
		try {
			return [JSON.parse(readFileSync(join(dir, version, 'module.json'), 'utf8')) as ModuleEntry]
		}
		catch {
			return []
		}
	})
}

function downloadedIds(): string[] {
	return existsSync(STORE) ? readdirSync(STORE).filter(id => ID.test(id) && id !== 'restricted') : []
}

/** The newest copy of a module compatible with this app (shipped or downloaded), null: none. */
function bestCopy(id: string, builtIn?: ModuleEntry): Active | null {
	let best: Active | null = builtIn ? { ...builtIn, dir: null } : null
	for (const copy of downloaded(id)) {
		if (satisfies(sdk.version, copy.sdk) && (!best || compareVersions(copy.version, best.version) > 0)) {
			best = { ...copy, dir: join(STORE, copy.id, copy.version) }
		}
	}
	return best
}

/** Decides what each module runs this session: its newest copy compatible with this app. */
function resolveActive(): void {
	const shipped = new Map(builtIns().map(e => [e.id, e]))
	const next = new Map<string, Active>()
	for (const id of new Set([...shipped.keys(), ...downloadedIds()])) {
		const best = bestCopy(id, shipped.get(id))
		if (best) next.set(id, best)
	}
	active = next
	const updated = [...active.values()].filter(m => m.dir).map(m => `${m.id} ${m.version}`)
	if (updated.length) console.log('[modules] running downloaded versions:', updated.join(', '))
}

/** An entry as the renderer sees it (no folder). */
function entry({ dir: _dir, ...module }: Active): ModuleEntry {
	return module
}

/**
 * Answers the file protocol for modules/… (the catalogue of this session, a downloaded module's
 * files); everything else goes through as usual.
 */
function serve(): void {
	protocol.handle('file', request => {
		const path = fileURLToPath(request.url)
		const rel = relative(BUILT_IN, path)
		if (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '') {
			if (rel === 'catalog.js') {
				const list = [...active.values()].map(entry)
				return new Response(`export default ${JSON.stringify(list)}\n`, { headers: { 'content-type': 'text/javascript' } })
			}
			const [id, ...rest] = rel.split(sep)
			const module = active.get(id)
			if (module?.dir && rest.length === 1 && FILE.test(rest[0])) {
				return net.fetch(pathToFileURL(join(module.dir, rest[0])).href, { bypassCustomProtocolHandlers: true })
			}
		}
		return net.fetch(request, { bypassCustomProtocolHandlers: true })
	})
}

function valid(entries: unknown): RemoteEntry[] {
	if (!Array.isArray(entries)) return []
	return (entries as RemoteEntry[]).filter(e => e && ID.test(e.id) && VERSION.test(e.version) && typeof e.sdk === 'string'
		&& Array.isArray(e.files) && e.files.every(f => PUBLISHED_FILE.test(f.path) && !f.path.includes('..') && /^[a-f0-9]{64}$/.test(f.sha256)
			&& (f.platform === undefined || typeof f.platform === 'string')))
}

/** id → a restricted module's newest entry, and its files' URLs (handed over this session only). */
const restricted = new Map<string, { entry: RemoteEntry, urls: Record<string, string> }>()
/** whether the server listed the restricted modules this session (until then, the last list holds) */
let restrictedListed = false

/** A restricted module's entry if it matches its signature (the update key), else null. */
function trustedRestricted(module: RestrictedModule): RemoteEntry | null {
	if (!signedEntry(module.entry, module.signature, module.publisher)) return null
	try {
		return valid([JSON.parse(module.entry)])[0] ?? null
	}
	catch {
		return null
	}
}

/** The restricted modules handed over last time (signatures checked again), until the server lists them. */
function loadRestricted(): void {
	if (!existsSync(RESTRICTED)) return
	for (const name of readdirSync(RESTRICTED)) {
		try {
			const entry = trustedRestricted(JSON.parse(readFileSync(join(RESTRICTED, name), 'utf8')) as RestrictedModule)
			if (entry && `${entry.id}.json` === name) restricted.set(entry.id, { entry, urls: {} })
		}
		catch {
			// unreadable: left for the next list
		}
	}
}

/**
 * The restricted modules this account was given, as the server lists them (the renderer asks it):
 * each entry checked against its signature, kept for when the server is out of reach. One no
 * longer listed is forgotten (and its files dropped at the next update check).
 */
async function setRestricted(modules: unknown): Promise<void> {
	if (!Array.isArray(modules)) return
	const next = new Map<string, { entry: RemoteEntry, urls: Record<string, string> }>()
	for (const module of modules as RestrictedModule[]) {
		if (typeof module?.entry !== 'string' || typeof module.signature !== 'string') continue
		const entry = trustedRestricted(module)
		if (!entry) {
			console.error('[modules] a restricted module does not match its signature: ignored')
			continue
		}
		next.set(entry.id, { entry, urls: module.urls && typeof module.urls === 'object' ? module.urls : {} })
		mkdirSync(RESTRICTED, { recursive: true })
		writeFileSync(join(RESTRICTED, `${entry.id}.json`), JSON.stringify({ entry: module.entry, signature: module.signature, publisher: module.publisher }))
	}
	for (const name of existsSync(RESTRICTED) ? readdirSync(RESTRICTED) : []) {
		if (!next.has(name.replace(/\.json$/, ''))) rmSync(join(RESTRICTED, name), { force: true })
	}
	restricted.clear()
	for (const [id, value] of next) restricted.set(id, value)
	restrictedListed = true
	await checkModuleUpdates()
}

/** The restricted modules' entries known now. */
function restrictedEntries(): RemoteEntry[] {
	return [...restricted.values()].map(r => r.entry)
}

/** A native file of whichever installed module brings it (this platform's), or null: e.g. Private's wireproxy. */
function findNative(name: string): string | null {
	for (const module of active.values()) {
		if (!module.dir) continue
		const path = join(module.dir, 'native', PLATFORM, name)
		if (existsSync(path)) return path
	}
	return null
}

/** The server's module registry: each published module's entry, signed alone by CI (null: none usable). */
const REGISTRY_URL = TESTING ? `${MODULES_URL}registry.json` : new URL('/api/hub/modules/catalog', RELEASES_URL).href

async function registryCatalog(): Promise<RemoteEntry[] | null> {
	const response = await fetchBuffer(REGISTRY_URL)
	if (response.status !== 200) return null
	const list = (JSON.parse(response.body.toString('utf8')) as { data?: unknown }).data
	if (!Array.isArray(list)) return null
	const entries: unknown[] = []
	for (const item of list as Array<{ entry?: unknown, signature?: unknown, publisher?: Publisher }>) {
		if (typeof item?.entry !== 'string' || typeof item?.signature !== 'string' || !signedEntry(item.entry, item.signature, item.publisher)) {
			console.error('[modules] a registry entry does not match its signature: ignored')
			continue
		}
		entries.push(JSON.parse(item.entry))
	}
	const usable = valid(entries)
	return usable.length ? usable : null
}

/**
 * The published catalogue: the registry's signed entries (the server picks which are published,
 * a withdrawn module leaves); null when out of reach or not trusted (the last one read holds).
 */
async function remoteCatalog(): Promise<RemoteEntry[] | null> {
	const registry = await registryCatalog()
	if (!registry) return null
	mkdirSync(STORE, { recursive: true })
	writeFileSync(LAST_CATALOG, JSON.stringify(registry))
	return registry
}

/** A catalogue read this recently is used again (several modules installed in a row). */
const FRESH_FOR_MS = 60_000
let recent: { at: number, entries: RemoteEntry[] } | null = null

/** The published catalogue: fresh, else the last one read. */
async function publishedCatalog(): Promise<RemoteEntry[]> {
	if (recent && Date.now() - recent.at < FRESH_FOR_MS) return [...recent.entries, ...restrictedEntries()]
	const fresh = await remoteCatalog().catch(err => {
		console.warn('[modules] catalogue out of reach:', err instanceof Error ? err.message : err)
		return null
	})
	if (fresh) {
		recent = { at: Date.now(), entries: fresh }
		return [...fresh, ...restrictedEntries()]
	}
	try {
		return [...valid(JSON.parse(readFileSync(LAST_CATALOG, 'utf8'))), ...restrictedEntries()]
	}
	catch {
		return restrictedEntries()
	}
}

/** Downloads one published version, every file checked, then moves it in place at once. */
async function download(published: RemoteEntry): Promise<void> {
	const final = join(STORE, published.id, published.version)
	const partial = `${final}.partial`
	rmSync(partial, { recursive: true, force: true })
	mkdirSync(partial, { recursive: true })
	try {
		const urls = restricted.get(published.id)?.entry.version === published.version ? restricted.get(published.id)!.urls : null
		for (const file of published.files) {
			if (file.platform && file.platform !== PLATFORM) continue
			const url = urls ? urls[file.path] : `${MODULES_URL}${published.id}/${published.version}/${file.path}`
			if (!url) throw new Error(`${file.path}: no download URL (restricted module, list it again)`)
			const { status, body } = await fetchBuffer(url)
			if (status !== 200) throw new Error(`${file.path}: HTTP ${status}`)
			if (createHash('sha256').update(body).digest('hex') !== file.sha256) throw new Error(`${file.path}: checksum mismatch`)
			mkdirSync(dirname(join(partial, file.path)), { recursive: true })
			writeFileSync(join(partial, file.path), body)
			// native files are run (the VPN's wireproxy)
			if (file.platform) chmodSync(join(partial, file.path), 0o755)
		}
		const { files: _files, ...module } = published
		writeFileSync(join(partial, 'module.json'), JSON.stringify(module))
		rmSync(final, { recursive: true, force: true })
		mkdirSync(dirname(final), { recursive: true })
		renameSync(partial, final)
		console.log(`[modules] ${published.id} ${published.version} downloaded`)
	}
	catch (err) {
		rmSync(partial, { recursive: true, force: true })
		throw err
	}
}

/** Downloaded versions no longer of use: older than both the running one and the newest. */
function prune(id: string): void {
	const copies = downloaded(id).map(c => c.version).sort(compareVersions)
	const keep = new Set([active.get(id)?.version, copies.at(-1)])
	for (const version of copies) {
		if (!keep.has(version)) rmSync(join(STORE, id, version), { recursive: true, force: true })
	}
}

/** The newest published version of a module this app can run. */
function newestCompatible(published: RemoteEntry[], id: string): RemoteEntry | null {
	return published
		.filter(e => e.id === id && satisfies(sdk.version, e.sdk))
		.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

/** The modules this app can have: the installed ones, and the compatible published ones. */
async function listModules(): Promise<{ modules: ModuleEntry[], installed: string[] }> {
	const published = await publishedCatalog()
	const modules = new Map<string, ModuleEntry>()
	for (const id of new Set(published.map(e => e.id))) {
		const newest = newestCompatible(published, id)
		if (newest) {
			const { files: _files, ...module } = newest
			modules.set(id, module)
		}
	}
	for (const module of active.values()) modules.set(module.id, entry(module))
	return { modules: [...modules.values()], installed: [...active.keys()] }
}

const installing = new Map<string, Promise<ModuleEntry>>()

/** Installs a module (its newest compatible version) and makes it usable in this session. */
function installModule(id: string): Promise<ModuleEntry> {
	const running = active.get(id)
	if (running) return Promise.resolve(entry(running))
	let pending = installing.get(id)
	if (!pending) {
		pending = (async () => {
			let copy = bestCopy(id)
			if (!copy) {
				const published = newestCompatible(await publishedCatalog(), id)
				if (!published) throw new Error(`${id}: not published for this version of the app`)
				await download(published)
				copy = bestCopy(id)
				if (!copy) throw new Error(`${id}: downloaded but not usable`)
			}
			active.set(id, copy)
			return entry(copy)
		})().finally(() => installing.delete(id))
		installing.set(id, pending)
	}
	return pending
}

/** Removes a module's downloaded files (one the build ships stays). Loaded, it stays until restart. */
function uninstallModule(id: string): void {
	rmSync(join(STORE, id), { recursive: true, force: true })
	if (active.get(id)?.dir) active.delete(id)
	console.log(`[modules] ${id} removed from this device`)
}

/**
 * Removes the downloaded modules the server no longer publishes (a module taken out of the app):
 * hidden already (the server doesn't serve them), their files go. Never on an empty catalogue.
 */
function dropUnpublished(published: RemoteEntry[]): void {
	// never before the server listed the restricted modules this session (they are not in the
	// public catalogue: one would be taken for unpublished)
	if (published.length === 0 || !restrictedListed) return
	const ids = new Set(published.map(e => e.id))
	for (const id of restricted.keys()) ids.add(id)
	for (const id of downloadedIds()) {
		if (ids.has(id)) continue
		rmSync(join(STORE, id), { recursive: true, force: true })
		if (active.get(id)?.dir) active.delete(id)
		console.log(`[modules] ${id} is no longer published: removed from this device`)
	}
}

/**
 * The newer versions already downloaded than what runs ("id version"): what activateModules would
 * switch to.
 */
function pendingModules(): string[] {
	const shipped = new Map(builtIns().map(e => [e.id, e]))
	const newer: string[] = []
	for (const [id, running] of active) {
		const best = bestCopy(id, shipped.get(id))
		if (best && compareVersions(best.version, running.version) > 0) newer.push(`${id} ${best.version}`)
	}
	return newer
}

/** Decides the versions again, as at start: the renderer reloads right after. Returns what changed. */
function activateModules(): string[] {
	const newer = pendingModules()
	if (newer.length) {
		resolveActive()
		console.log('[modules] activated without a restart:', newer.join(', '))
	}
	return newer
}

/**
 * Answers hubby://<id>/…: the frame page (/), the hubby runtime (/_runtime/…), the hubby's own
 * files (its active version; an isolated module only, once the catalogue is known). Every answer
 * allows any origin (the frame's is opaque) and is never cached (a module switches versions).
 */
function serveHubbies(): void {
	protocol.handle(HUBBY_SCHEME, async request => {
		const url = new URL(request.url)
		const id = url.hostname
		const path = decodeURIComponent(url.pathname).replace(/^\//, '')
		let file: string | null = null
		if (ID.test(id) && !/(^|\/)\.\.?(\/|$)/.test(path)) {
			if (path === '' || path === 'index.html') file = join(RUNTIME, 'frame.html')
			else if (path.startsWith('_runtime/') && RUNTIME_PATH.test(path.slice(9))) file = join(RUNTIME, path.slice(9))
			else if (FILE.test(path)) {
				const module = active.get(id)
				if (module === undefined || module.isolated === true) file = join(module?.dir ?? join(BUILT_IN, id), path)
			}
		}
		if (file === null || !existsSync(file)) return new Response('Not found', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
		return new Response(readFileSync(file), {
			headers: {
				'Content-Type': TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream',
				'Access-Control-Allow-Origin': '*',
				'Cache-Control': 'no-store'
			}
		})
	})
}

let checking = false

/** Looks for newer compatible versions of the installed modules and downloads them (for the next start). */
export async function checkModuleUpdates(): Promise<void> {
	if (checking) return
	checking = true
	try {
		const offered = await remoteCatalog()
		if (!offered) return
		const published = [...offered, ...restrictedEntries()]
		for (const id of active.keys()) {
			const latest = newestCompatible(published, id)
			if (!latest) continue
			const newest = [active.get(id)!.version, ...downloaded(id).map(c => c.version)].sort(compareVersions).at(-1)!
			if (compareVersions(latest.version, newest) <= 0) continue
			try {
				await download(latest)
				console.log(`[modules] ${id} ${latest.version}: used from the next start`)
			}
			catch (err) {
				console.warn(`[modules] ${id} ${latest.version} not downloaded:`, err instanceof Error ? err.message : err)
			}
		}
		for (const id of active.keys()) prune(id)
		dropUnpublished(published)
	}
	catch (err) {
		console.warn('[modules] update check failed:', err instanceof Error ? err.message : err)
	}
	finally {
		checking = false
	}
}

function moduleId(id: unknown): string {
	if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid module id')
	return id
}

/** At start, before any window: decides the versions of this session and serves them. */
export function setupModules(): void {
	ipcMain.handle('modules:list', () => listModules())
	ipcMain.handle('modules:install', (_event, id: unknown) => installModule(moduleId(id)))
	ipcMain.handle('modules:uninstall', (_event, id: unknown) => uninstallModule(moduleId(id)))
	ipcMain.handle('modules:restricted', (_event, modules: unknown) => setRestricted(modules))
	ipcMain.handle('modules:pending', () => pendingModules())
	ipcMain.handle('modules:activate', () => activateModules())
	serveHubbies()
	if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) return // dev server: modules from their sources
	loadRestricted()
	registerNativeLookup(findNative)
	resolveActive()
	serve()
	if (app.isPackaged || TESTING) {
		void checkModuleUpdates()
		setInterval(() => void checkModuleUpdates(), CHECK_EVERY_MS)
	}
}
