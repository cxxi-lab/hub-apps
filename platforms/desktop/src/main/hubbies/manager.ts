import { app, BrowserWindow, ipcMain, net, protocol } from 'electron'
import { createHash, createPublicKey, verify } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import sdk from '@cxxi-lab/hubbyware-sdk/version.json'
import { UPDATE_SIGNING_PUBLIC_KEY } from '../network/updateSigningKey'
import { fetchBuffer, RELEASES_URL } from '../network/updater'
import { removeTunnel } from '../network/component'
import { registerVpnHubbies } from '../network/vpnConfig'
import { hubbyPartition, webSession } from '../session/sessions'
import { compareVersions, fits } from './semver'
import { HUBBY_SCHEME } from '../app/schemes'

/**
 * The hubbies of this device, apart from the app (see app/scripts/build-hubbies.mjs):
 *  - the server's hubby registry lists every published hubby (/api/hub/hubbies/catalog), each
 *    entry signed alone by CI with the update key: the server picks what is published, it can't
 *    forge an entry;
 *  - a hubby is installed on demand (enabled, see the app's core/hubby/registry): its newest
 *    version compatible with this app's SDK is downloaded into userData/hubbies/<id>/<version>/,
 *    every file checked against the signed catalogue, and usable at once;
 *  - an installed hubby's newer versions are downloaded in the background, and the version each
 *    one runs is decided once, at start (no half-updated session);
 *  - a build may still ship hubbies (out/renderer/hubbies/<id>, a build run from the sources): a
 *    downloaded newer copy wins over them.
 *  - the restricted hubbies (offered only to the accounts given them) are not in that catalogue: the
 *    renderer hands their entries over (setRestricted, from the server's authenticated list), each
 *    signed alone with the same key, with signed URLs for their files;
 *  - a hubby brings no native file: one an older version lists (native/<platform>/…) isn't
 *    downloaded (the VPN tunnel is the platform's, network/component.ts).
 * The renderer loads hubbies/<id>/… at the app's own address, whichever copy it is (the file
 * protocol is answered here): their relative imports of shared/*.js reach the app's files, so
 * there is one React, one SDK.
 */

/** A catalogue entry (HubbyPackage in the app): id, version, sdk range, css, and its description. */
interface HubbyEntry {
	id: string
	version: string
	sdk: string
	css: boolean
	[field: string]: unknown
}

interface RemoteEntry extends HubbyEntry {
	/** `platform`: a native file of an older version (never downloaded) */
	files: { path: string, sha256: string, platform?: string }[]
}

/** A restricted hubby handed over by the renderer: its signed entry, and where to get each file. */
interface RestrictedHubby {
	entry: string
	/** base64 */
	signature: string
	urls?: Record<string, string>
	/** signed by its publisher's key: that key's certificate (see signedEntry) */
	publisher?: Publisher
}

/** A key allowed to sign one hubby's entries: {"hubby", "key" (SPKI DER, base64)}, certified by the update key. */
interface Publisher {
	certificate: string
	signature: string
}

/**
 * Whether an entry is signed: by the update key, or by its publisher's key, which the update key
 * certified for that hubby only (a third party's hubby).
 */
function signedEntry(entry: string, signature: string, publisher?: Publisher): boolean {
	const body = Buffer.from(entry, 'utf8')
	const sig = Buffer.from(signature, 'base64')
	if (verify(null, body, PUBLIC_KEY, sig)) return true
	if (!publisher || typeof publisher.certificate !== 'string' || typeof publisher.signature !== 'string') return false
	if (!verify(null, Buffer.from(publisher.certificate, 'utf8'), PUBLIC_KEY, Buffer.from(publisher.signature, 'base64'))) return false
	try {
		// {"module": <id>, "key": …}: the field's name signed into the certificates (kept: a hubby's
		// certificate is signed once by the update key); `hubby` for one issued after the rename
		const certificate = JSON.parse(publisher.certificate) as { hubby?: unknown, module?: unknown, key?: unknown }
		if (typeof certificate.key !== 'string' || (certificate.hubby ?? certificate.module) !== (JSON.parse(entry) as { id?: unknown }).id) return false
		return verify(null, body, createPublicKey({ key: Buffer.from(certificate.key, 'base64'), format: 'der', type: 'spki' }), sig)
	}
	catch {
		return false
	}
}

interface Active extends HubbyEntry {
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
/** a published file (an older version's native one: native/<platform>/<name>, skipped) */
const PUBLISHED_FILE = /^[A-Za-z0-9._-]{1,80}(\/[A-Za-z0-9._-]{1,80}){0,2}$/
/**
 * Builds run from the sources only (never an installed app): a local release folder and its key,
 * to try hubby updates end to end without publishing (HUB_HUBBIES_URL, its registry.json in the
 * registry's format, HUB_HUBBIES_PUBLIC_KEY, HUB_HUBBIES_STORE).
 */
const TESTING = !app.isPackaged && !!process.env['HUB_HUBBIES_URL']
const HUBBIES_URL = TESTING ? process.env['HUB_HUBBIES_URL']!.replace(/\/?$/, '/') : `${RELEASES_URL}hubbies/`
const PUBLIC_KEY = TESTING && process.env['HUB_HUBBIES_PUBLIC_KEY'] ? readFileSync(process.env['HUB_HUBBIES_PUBLIC_KEY'], 'utf8') : UPDATE_SIGNING_PUBLIC_KEY
// (a test keeps its downloads apart too: a source build shares its profile folder with the installed app)
const STORE = TESTING && process.env['HUB_HUBBIES_STORE'] ? process.env['HUB_HUBBIES_STORE'] : join(app.getPath('userData'), 'modules')
/** The last published catalogue read (its signature checked then), for when the server is out of reach. */
const LAST_CATALOG = join(STORE, 'catalog.json')

/** The restricted hubbies' signed entries, as last handed over (for when the server is out of reach). */
const RESTRICTED = join(STORE, 'restricted')

/** Look for hubby updates this often, besides at start. */
const CHECK_EVERY_MS = 30 * 60_000

/** id → the version running this session, decided at start (or at its install). */
let active = new Map<string, Active>()

/** The hubbies the build ships (a release ships none: they are installed from the server). */
function builtIns(): HubbyEntry[] {
	try {
		const entries = JSON.parse(readFileSync(join(BUILT_IN, 'catalog.json'), 'utf8')) as HubbyEntry[]
		return entries.filter(e => existsSync(join(BUILT_IN, e.id, 'index.js')))
	}
	catch {
		return []
	}
}

/** The downloaded versions of a hubby, complete ones only (a download lands in place once checked). */
function downloaded(id: string): HubbyEntry[] {
	const dir = join(STORE, id)
	if (!existsSync(dir)) return []
	return readdirSync(dir).filter(v => VERSION.test(v)).flatMap(version => {
		try {
			return [JSON.parse(readFileSync(join(dir, version, 'module.json'), 'utf8')) as HubbyEntry]
		}
		catch {
			return []
		}
	})
}

function downloadedIds(): string[] {
	return existsSync(STORE) ? readdirSync(STORE).filter(id => ID.test(id) && id !== 'restricted') : []
}

/** The newest copy of a hubby compatible with this app (shipped or downloaded), null: none. */
function bestCopy(id: string, builtIn?: HubbyEntry): Active | null {
	let best: Active | null = builtIn ? { ...builtIn, dir: null } : null
	for (const copy of downloaded(id)) {
		// a copy this app's SDK can't serve: said (a whole catalogue refused shows here first)
		if (!fits(sdk, copy.sdk)) console.warn(`[hubbies] ${copy.id} ${copy.version} needs SDK ${copy.sdk}; this app has ${sdk.version}${sdk.compatible?.length ? ` (and serves ${sdk.compatible.join(', ')})` : ''}`)
		if (fits(sdk, copy.sdk) && (!best || compareVersions(copy.version, best.version) > 0)) {
			best = { ...copy, dir: join(STORE, copy.id, copy.version) }
		}
	}
	return best
}

/** Decides what each hubby runs this session: its newest copy compatible with this app. */
function resolveActive(): void {
	const shipped = new Map(builtIns().map(e => [e.id, e]))
	const next = new Map<string, Active>()
	for (const id of new Set([...shipped.keys(), ...downloadedIds()])) {
		const best = bestCopy(id, shipped.get(id))
		if (best) next.set(id, best)
	}
	active = next
	const updated = [...active.values()].filter(m => m.dir).map(m => `${m.id} ${m.version}`)
	if (updated.length) console.log('[hubbies] running downloaded versions:', updated.join(', '))
}

/** An entry as the renderer sees it (no folder). */
function entry({ dir: _dir, ...hubby }: Active): HubbyEntry {
	return hubby
}

/**
 * Answers the file protocol for hubbies/… (the catalogue of this session, a downloaded hubby's
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
			const hubby = active.get(id)
			if (hubby?.dir && rest.length === 1 && FILE.test(rest[0])) {
				return net.fetch(pathToFileURL(join(hubby.dir, rest[0])).href, { bypassCustomProtocolHandlers: true })
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

/** id → a restricted hubby's newest entry, and its files' URLs (handed over this session only). */
const restricted = new Map<string, { entry: RemoteEntry, urls: Record<string, string> }>()
/** whether the server listed the restricted hubbies this session (until then, the last list holds) */
let restrictedListed = false

/** A restricted hubby's entry if it matches its signature (the update key), else null. */
function trustedRestricted(hubby: RestrictedHubby): RemoteEntry | null {
	if (!signedEntry(hubby.entry, hubby.signature, hubby.publisher)) return null
	try {
		return valid([JSON.parse(hubby.entry)])[0] ?? null
	}
	catch {
		return null
	}
}

/** The restricted hubbies handed over last time (signatures checked again), until the server lists them. */
function loadRestricted(): void {
	if (!existsSync(RESTRICTED)) return
	for (const name of readdirSync(RESTRICTED)) {
		try {
			const entry = trustedRestricted(JSON.parse(readFileSync(join(RESTRICTED, name), 'utf8')) as RestrictedHubby)
			if (entry && `${entry.id}.json` === name) restricted.set(entry.id, { entry, urls: {} })
		}
		catch {
			// unreadable: left for the next list
		}
	}
}

/**
 * The restricted hubbies this account was given, as the server lists them (the renderer asks it):
 * each entry checked against its signature, kept for when the server is out of reach. One no
 * longer listed is forgotten (and its files dropped at the next update check).
 */
async function setRestricted(hubbies: unknown): Promise<void> {
	if (!Array.isArray(hubbies)) return
	const next = new Map<string, { entry: RemoteEntry, urls: Record<string, string> }>()
	for (const hubby of hubbies as RestrictedHubby[]) {
		if (typeof hubby?.entry !== 'string' || typeof hubby.signature !== 'string') continue
		const entry = trustedRestricted(hubby)
		if (!entry) {
			console.error('[hubbies] a restricted hubby does not match its signature: ignored')
			continue
		}
		next.set(entry.id, { entry, urls: hubby.urls && typeof hubby.urls === 'object' ? hubby.urls : {} })
		mkdirSync(RESTRICTED, { recursive: true })
		writeFileSync(join(RESTRICTED, `${entry.id}.json`), JSON.stringify({ entry: hubby.entry, signature: hubby.signature, publisher: hubby.publisher }))
	}
	for (const name of existsSync(RESTRICTED) ? readdirSync(RESTRICTED) : []) {
		if (!next.has(name.replace(/\.json$/, ''))) rmSync(join(RESTRICTED, name), { force: true })
	}
	restricted.clear()
	for (const [id, value] of next) restricted.set(id, value)
	restrictedListed = true
	await checkHubbyUpdates()
}

/** The restricted hubbies' entries known now. */
function restrictedEntries(): RemoteEntry[] {
	return [...restricted.values()].map(r => r.entry)
}

/** Whether a hubby goes out through the VPN (hubby.json `network`, formerly `supports: ['vpn']`). */
function needsVpn(hubby: HubbyEntry): boolean {
	const network = hubby['network'] as unknown
	return network === 'vpn'
		|| (typeof network === 'object' && network !== null && (network as { egress?: unknown }).egress === 'vpn')
		|| (Array.isArray(hubby['supports']) && (hubby['supports'] as unknown[]).includes('vpn'))
}

/** The tunnel (a platform component, network/component.ts) stays only while a hubby needs it. */
function pruneTunnel(): void {
	if (![...active.values()].some(needsVpn)) removeTunnel()
}

/**
 * The webview sessions of the hubbies going out through the VPN, set up before any of their
 * webviews exists: their proxy (or its kill switch) is in place before the first request.
 */
function prepareVpnSessions(): void {
	for (const hubby of active.values()) if (needsVpn(hubby)) webSession(hubbyPartition(hubby.id))
}

/** The server's hubby registry: each published hubby's entry, signed alone by CI (null: none usable). */
const REGISTRY_URL = TESTING ? `${HUBBIES_URL}registry.json` : new URL('/api/hub/hubbies/catalog', RELEASES_URL).href

async function registryCatalog(): Promise<RemoteEntry[] | null> {
	const response = await fetchBuffer(REGISTRY_URL)
	if (response.status !== 200) return null
	const list = (JSON.parse(response.body.toString('utf8')) as { data?: unknown }).data
	if (!Array.isArray(list)) return null
	const entries: unknown[] = []
	for (const item of list as Array<{ entry?: unknown, signature?: unknown, publisher?: Publisher }>) {
		if (typeof item?.entry !== 'string' || typeof item?.signature !== 'string' || !signedEntry(item.entry, item.signature, item.publisher)) {
			console.error('[hubbies] a registry entry does not match its signature: ignored')
			continue
		}
		entries.push(JSON.parse(item.entry))
	}
	const usable = valid(entries)
	return usable.length ? usable : null
}

/**
 * The published catalogue: the registry's signed entries (the server picks which are published,
 * a withdrawn hubby leaves); null when out of reach or not trusted (the last one read holds).
 */
async function remoteCatalog(): Promise<RemoteEntry[] | null> {
	const registry = await registryCatalog()
	if (!registry) return null
	mkdirSync(STORE, { recursive: true })
	writeFileSync(LAST_CATALOG, JSON.stringify(registry))
	return registry
}

/** A catalogue read this recently is used again (several hubbies installed in a row). */
const FRESH_FOR_MS = 60_000
let recent: { at: number, entries: RemoteEntry[] } | null = null

/** The published catalogue: fresh, else the last one read. */
async function publishedCatalog(): Promise<RemoteEntry[]> {
	if (recent && Date.now() - recent.at < FRESH_FOR_MS) return [...recent.entries, ...restrictedEntries()]
	const fresh = await remoteCatalog().catch(err => {
		console.warn('[hubbies] catalogue out of reach:', err instanceof Error ? err.message : err)
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
			// a hubby brings no native file (an older version's: not downloaded)
			if (file.platform) continue
			const url = urls ? urls[file.path] : `${HUBBIES_URL}${published.id}/${published.version}/${file.path}`
			if (!url) throw new Error(`${file.path}: no download URL (restricted hubby, list it again)`)
			const { status, body } = await fetchBuffer(url)
			if (status !== 200) throw new Error(`${file.path}: HTTP ${status}`)
			if (createHash('sha256').update(body).digest('hex') !== file.sha256) throw new Error(`${file.path}: checksum mismatch`)
			mkdirSync(dirname(join(partial, file.path)), { recursive: true })
			writeFileSync(join(partial, file.path), body)
		}
		const { files: _files, ...hubby } = published
		writeFileSync(join(partial, 'module.json'), JSON.stringify(hubby))
		rmSync(final, { recursive: true, force: true })
		mkdirSync(dirname(final), { recursive: true })
		renameSync(partial, final)
		console.log(`[hubbies] ${published.id} ${published.version} downloaded`)
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

/** The newest published version of a hubby this app can run. */
function newestCompatible(published: RemoteEntry[], id: string): RemoteEntry | null {
	return published
		.filter(e => e.id === id && fits(sdk, e.sdk))
		.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
}

/** The hubbies this app can have: the installed ones, and the compatible published ones. */
async function listHubbies(): Promise<{ hubbies: HubbyEntry[], installed: string[] }> {
	const published = await publishedCatalog()
	const hubbies = new Map<string, HubbyEntry>()
	for (const id of new Set(published.map(e => e.id))) {
		const newest = newestCompatible(published, id)
		if (newest) {
			const { files: _files, ...hubby } = newest
			hubbies.set(id, hubby)
		}
	}
	for (const hubby of active.values()) hubbies.set(hubby.id, entry(hubby))
	return { hubbies: [...hubbies.values()], installed: [...active.keys()] }
}

const installing = new Map<string, Promise<HubbyEntry>>()

/** Installs a hubby (its newest compatible version) and makes it usable in this session. */
function installHubby(id: string): Promise<HubbyEntry> {
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
			prepareVpnSessions()
			return entry(copy)
		})().finally(() => installing.delete(id))
		installing.set(id, pending)
	}
	return pending
}

/** Removes a hubby's downloaded files (one the build ships stays). Loaded, it stays until restart. */
function uninstallHubby(id: string): void {
	rmSync(join(STORE, id), { recursive: true, force: true })
	if (active.get(id)?.dir) active.delete(id)
	console.log(`[hubbies] ${id} removed from this device`)
	pruneTunnel()
}

/**
 * Removes the downloaded hubbies the server no longer publishes (a hubby taken out of the app):
 * hidden already (the server doesn't serve them), their files go. Never on an empty catalogue.
 */
function dropUnpublished(published: RemoteEntry[]): void {
	// never before the server listed the restricted hubbies this session (they are not in the
	// public catalogue: one would be taken for unpublished)
	if (published.length === 0 || !restrictedListed) return
	const ids = new Set(published.map(e => e.id))
	for (const id of restricted.keys()) ids.add(id)
	for (const id of downloadedIds()) {
		if (ids.has(id)) continue
		rmSync(join(STORE, id), { recursive: true, force: true })
		if (active.get(id)?.dir) active.delete(id)
		console.log(`[hubbies] ${id} is no longer published: removed from this device`)
	}
}

/**
 * The newer versions already downloaded than what runs ("id version"): what activateHubbies would
 * switch to.
 */
function pendingHubbies(): string[] {
	const shipped = new Map(builtIns().map(e => [e.id, e]))
	const newer: string[] = []
	for (const [id, running] of active) {
		const best = bestCopy(id, shipped.get(id))
		if (best && compareVersions(best.version, running.version) > 0) newer.push(`${id} ${best.version}`)
	}
	return newer
}

/**
 * Runs the newer downloaded versions from now on: all of them (as at start: the renderer reloads
 * right after), or only these hubbies' (an isolated hubby switches alone, its frame reloaded:
 * the others keep running). Returns what changed ("id version").
 */
function activateHubbies(ids?: string[]): string[] {
	if (!ids) {
		const newer = pendingHubbies()
		if (newer.length) {
			resolveActive()
			prepareVpnSessions()
			console.log('[hubbies] activated without a restart:', newer.join(', '))
		}
		return newer
	}
	const shipped = new Map(builtIns().map(e => [e.id, e]))
	const newer: string[] = []
	for (const id of ids) {
		const running = active.get(id)
		const best = running ? bestCopy(id, shipped.get(id)) : null
		if (!running || !best || compareVersions(best.version, running.version) <= 0) continue
		active.set(id, best)
		newer.push(`${id} ${best.version}`)
	}
	if (newer.length) {
		prepareVpnSessions()
		console.log('[hubbies] updated:', newer.join(', '))
	}
	return newer
}

/**
 * Answers hubby://<id>/…: the frame page (/), the hubby runtime (/_runtime/…), the hubby's own
 * files (its active version; an isolated hubby only, once the catalogue is known). Every answer
 * allows any origin (the frame's is opaque) and is never cached (a hubby switches versions).
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
				const hubby = active.get(id)
				if (hubby === undefined || hubby.isolated === true) file = join(hubby?.dir ?? join(BUILT_IN, id), path)
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

/** Looks for newer compatible versions of the installed hubbies and downloads them (for the next start). */
/**
 * The hubbies' declarations as this session runs them (their hubby.json, from the copy checked when
 * it was installed; development: their sources): what the platform acts on for them (their AI
 * models: ai/models.ts), never what a renderer says they declare.
 */
export function hubbyDeclarations(): Array<HubbyEntry & Record<string, unknown>> {
	const running = [...active.values()].map(entry)
	if (app.isPackaged) return running
	const ids = new Set(running.map(h => h.id))
	return [...running, ...devSourceHubbies().filter(h => !ids.has(h.id))]
}

export async function checkHubbyUpdates(): Promise<void> {
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
				console.log(`[hubbies] ${id} ${latest.version}: used from the next start`)
			}
			catch (err) {
				console.warn(`[hubbies] ${id} ${latest.version} not downloaded:`, err instanceof Error ? err.message : err)
			}
		}
		for (const id of active.keys()) prune(id)
		dropUnpublished(published)
	}
	catch (err) {
		console.warn('[hubbies] update check failed:', err instanceof Error ? err.message : err)
	}
	finally {
		checking = false
	}
}

function hubbyId(id: unknown): string {
	if (typeof id !== 'string' || !ID.test(id)) throw new Error('invalid hubby id')
	return id
}

/** At start, before any window: decides the versions of this session and serves them. */
/**
 * The development hubbies' declarations (their hubby.json, where the renderer reads them:
 * HUB_HUBBIES_DIR, else the official hubbies' checkout next to the apps', app/build/sharedRuntime.ts):
 * which go out through the VPN (the others' webviews go direct, as in a build).
 */
function devSourceHubbies(): HubbyEntry[] {
	const dir = process.env['HUB_HUBBIES_DIR'] ?? join(app.getAppPath(), '../../../hubbies')
	if (!existsSync(dir)) return []
	const out: HubbyEntry[] = []
	for (const name of readdirSync(dir)) {
		const file = join(dir, name, 'hubby.json')
		try {
			if (existsSync(file)) out.push({ id: name, ...JSON.parse(readFileSync(file, 'utf8')) } as HubbyEntry)
		}
		catch (err) {
			console.warn(`[hubbies] ${name}: hubby.json not read`, err)
		}
	}
	return out
}

/**
 * Development: a hubby's files rebuilt (`hubby dev`, into BUILT_IN/<id>) reload its frame: the
 * windows are told which hubby changed (once its build settles).
 */
function watchDevHubbies(): void {
	mkdirSync(BUILT_IN, { recursive: true })
	const timers = new Map<string, NodeJS.Timeout>()
	watch(BUILT_IN, { recursive: true }, (_event, file) => {
		// its entry.json is written last (hubby dev): its build is complete then
		const parts = typeof file === 'string' ? file.split(sep) : []
		const id = parts[0] ?? ''
		if (!ID.test(id) || parts.at(-1) !== 'entry.json') return
		clearTimeout(timers.get(id))
		timers.set(id, setTimeout(() => {
			timers.delete(id)
			for (const win of BrowserWindow.getAllWindows()) win.webContents.send('hubbies:dev-changed', id)
		}, 150))
	})
}

export function setupHubbies(): void {
	ipcMain.handle('hubbies:list', () => listHubbies())
	ipcMain.handle('hubbies:install', (_event, id: unknown) => installHubby(hubbyId(id)))
	ipcMain.handle('hubbies:uninstall', (_event, id: unknown) => uninstallHubby(hubbyId(id)))
	ipcMain.handle('hubbies:restricted', (_event, hubbies: unknown) => setRestricted(hubbies))
	ipcMain.handle('hubbies:pending', () => pendingHubbies())
	// a version just published (the server's real-time event): looked for now, not at the next half hour
	ipcMain.handle('hubbies:check', async () => { await checkHubbyUpdates(); return pendingHubbies() })
	ipcMain.handle('hubbies:activate', (_event, ids?: unknown) => activateHubbies(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && ID.test(id)) : undefined))
	serveHubbies()
	if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
		// dev server: hubbies from their sources (their files built by `hubby dev`, served from BUILT_IN)
		const vpn = devSourceHubbies().filter(needsVpn).map(h => h.id)
		registerVpnHubbies(() => vpn)
		watchDevHubbies()
		return
	}
	loadRestricted()
	registerVpnHubbies(() => [...active.values()].filter(needsVpn).map(h => h.id))
	resolveActive()
	pruneTunnel()
	prepareVpnSessions()
	serve()
	if (app.isPackaged || TESTING) {
		void checkHubbyUpdates()
		setInterval(() => void checkHubbyUpdates(), CHECK_EVERY_MS)
	}
}
