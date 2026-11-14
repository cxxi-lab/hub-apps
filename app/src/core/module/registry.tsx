import { useSyncExternalStore } from 'react'
import { faMusic, faNoteSticky, faShareNodes, faWallet } from '@fortawesome/free-solid-svg-icons'
import { platform, type ModulePackage, type RestrictedModulePackage } from '@platform'
import { api } from '@core/api/client'
import { entryIcon } from './describe'
import { HubbyHost } from '@core/hubby/HubbyHost'
import { registerModels, type ModelFile } from '@core/crypto/documents'
import { declareModule, type ModuleDeclaration } from './declarations'
import type { ModuleManifest } from './types'

export type { ModuleManifest, ModuleNavItem, ModuleRoute } from './types'

/** The catalogue order (top bar, home page, Settings); modules not listed come after. */
const ORDER = ['mail', 'ai', 'planner', 'memo', 'file-sharing', 'music', 'business', 'budget', 'workout']

/** Modules announced ahead of their pages, declared here. */
const PLACEHOLDERS: ModuleManifest[] = [
	{ id: 'memo', label: 'Memo', icon: faNoteSticky, description: 'Notes and reminders', navItems: [], routes: [] },
	{ id: 'file-sharing', label: 'File Sharing', icon: faShareNodes, description: 'Send and receive files', navItems: [], routes: [] },
	{ id: 'budget', label: 'Budget', icon: faWallet, description: 'Expenses and accounts', navItems: [], routes: [] },
	{ id: 'music', label: 'Music', icon: faMusic, description: 'Your music library', navItems: [], routes: [] }
]

/**
 * The module catalogue, in display order: the loaded modules, the ones published but not installed
 * on this device (stand-ins, see isInstalled), and the placeholders. Filled by loadModules() before
 * the app renders (every window awaits it); it changes as modules get installed (useRegistry).
 */
export const MODULE_MANIFESTS: ModuleManifest[] = []

/** The version of each loaded module (its module.json; the one actually loaded, built-in or downloaded). */
export const MODULE_VERSIONS: Record<string, string> = {}

/** Stand-ins of the modules not installed here: listed (Settings) from their catalogue entry, no pages. */
const standIns = new WeakSet<ModuleManifest>()

/** Where each module's install stands on this device, while it is not loaded. */
export type InstallState = { phase: 'installing' } | { phase: 'error', error: string, at: number }
export const INSTALLS = new Map<string, InstallState>()

const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
	revision++
	for (const cb of listeners) cb()
}

/** Re-renders when the catalogue changes (a module installed, a published one listed); its revision. */
export function useRegistry(): number {
	return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => revision)
}

let loading: Promise<void> | null = null

/**
 * Loads the modules: from their sources in development (all of them, hot reload), from their
 * bundles in a build (modules/<id>/index.js and style.css, the ones installed here, listed by
 * modules/catalog.js, see scripts/build-modules.mjs). The published ones not installed are listed
 * next, without waiting (refreshStore). A module that fails to load is left out; the app goes on.
 */
export function loadModules(): Promise<void> {
	loading ??= (async () => {
		const loaded = import.meta.env.DEV ? await fromSources() : await fromBundles()
		place([...loaded, ...PLACEHOLDERS.filter(p => !loaded.some(m => m.id === p.id))])
		void refreshStore()
	})()
	return loading
}

const rank = (id: string) => (ORDER.indexOf(id) + ORDER.length + 1) % (ORDER.length + 1)

/** Puts manifests in the catalogue (in place of the same module's), in display order. */
function place(manifests: ModuleManifest[]): void {
	for (const m of manifests) {
		const at = MODULE_MANIFESTS.findIndex(known => known.id === m.id)
		if (at >= 0) MODULE_MANIFESTS.splice(at, 1, m)
		else MODULE_MANIFESTS.push(m)
	}
	MODULE_MANIFESTS.sort((a, b) => rank(a.id) - rank(b.id))
}

/** Whether a module's pages are here (false: published, listed, not installed on this device). */
export function isInstalled(m: ModuleManifest): boolean {
	return !standIns.has(m)
}

function standIn(entry: ModulePackage, icon = entryIcon(entry)): ModuleManifest {
	const m: ModuleManifest = {
		id: entry.id,
		label: entry.label ?? entry.id,
		description: entry.description,
		icon,
		local: entry.local,
		requires: entry.requires,
		requiresCapabilities: entry.requiresCapabilities as ModuleManifest['requiresCapabilities'],
		navItems: [],
		routes: []
	}
	standIns.add(m)
	return m
}

let storeRead = 0
/** how many modules the store listed (installed ones included), last time */
let storeListed = 0
let awaitingStore = false

/** Lists the published modules not installed here (stand-ins). Without the server: the last catalogue read. */
export async function refreshStore(): Promise<void> {
	const store = platform.moduleStore
	if (!store) return
	// the restricted modules this account was given: listed by the server (with the session)
	await api<{ data: RestrictedModulePackage[] }>('/api/hub/modules/restricted')
		.then(res => store.setRestricted(res.data))
		.catch(err => console.warn('[modules] restricted modules not listed', err))
	try {
		const { modules } = await store.list()
		storeRead = Date.now()
		storeListed = modules.length
		const missing = modules.filter(e => !MODULE_MANIFESTS.some(m => m.id === e.id && isInstalled(m)))
		if (missing.length === 0) return
		place(missing.map(e => standIn(e)))
		changed()
	}
	catch (err) {
		console.warn('[modules] store not listed', err)
	}
}

/** A failed install is tried again after this long (when still wanted). */
const RETRY_AFTER_MS = 30_000

/**
 * Installs and loads the modules wanted here (enabled) that are not installed yet; idempotent,
 * called whenever the wanted list may have changed. An id not listed yet waits for the store.
 */
export function installModules(ids: string[]): void {
	const store = platform.moduleStore
	if (!store) return
	// enabled modules not listed while the store has listed nothing yet (the server out of reach at
	// the first start): ask it again, and come back. (Once it answered, an id it doesn't list is
	// not published for this app: left alone.)
	if (storeListed === 0 && ids.some(id => !MODULE_MANIFESTS.some(m => m.id === id))) {
		if (Date.now() - storeRead > RETRY_AFTER_MS) void refreshStore()
		if (!awaitingStore) {
			awaitingStore = true
			setTimeout(() => { awaitingStore = false; changed() }, RETRY_AFTER_MS + 100)
		}
	}
	for (const id of ids) {
		const m = MODULE_MANIFESTS.find(known => known.id === id)
		if (!m || isInstalled(m)) continue
		const state = INSTALLS.get(id)
		if (state?.phase === 'installing' || (state?.phase === 'error' && Date.now() - state.at < RETRY_AFTER_MS)) continue
		INSTALLS.set(id, { phase: 'installing' })
		changed()
		store.install(id)
			.then(async entry => {
				const manifest = (entry as { isolated?: boolean }).isolated
					? await loadModels(entry).then(() => isolatedManifest(entry as ModulePackage & { label: string }))
					: await loadBundle(entry)
				if (!manifest) throw new Error('the module did not load')
				MODULE_VERSIONS[id] = entry.version
				INSTALLS.delete(id)
				place([manifest])
				changed()
			})
			.catch(err => {
				const error = err instanceof Error ? err.message : String(err)
				console.warn(`[modules] ${id} not installed`, error)
				INSTALLS.set(id, { phase: 'error', error, at: Date.now() })
				changed()
				// the windows want it again then (their effects call back here)
				setTimeout(changed, RETRY_AFTER_MS + 100)
			})
	}
}

/** Removes a module from this device (a disabled one); it is listed again as not installed. */
export async function uninstallModule(id: string): Promise<void> {
	const store = platform.moduleStore
	const m = MODULE_MANIFESTS.find(known => known.id === id)
	if (!store || !m || !isInstalled(m)) return
	await store.uninstall(id)
	delete MODULE_VERSIONS[id]
	const { label, description, local, requires, requiresCapabilities } = m
	place([standIn({ id, version: '', sdk: '', css: false, label, description, local, requires, requiresCapabilities }, m.icon)])
	changed()
}

/**
 * An isolated hubby's manifest (docs/plan-module-architecture.md § 4 ter): none of its code runs in
 * the app; one route, /<id> and everything under it, shows its frame; its navigation is the one
 * the frame announces.
 */
function isolatedManifest(entry: { id: string, label: string, description?: string, icon?: ModulePackage['icon'], version?: string }): ModuleManifest {
	const Page = () => <HubbyHost module={entry.id} />
	return {
		id: entry.id,
		label: entry.label,
		description: entry.description,
		icon: entry.icon ? entryIcon(entry as ModulePackage) : undefined,
		isolated: true,
		navItems: [],
		routes: [{ path: `/${entry.id}`, Component: Page, persistent: true, prefix: true }]
	}
}

/** A module's manifest among its entry's exports. */
function manifestOf(exports: Record<string, unknown>): ModuleManifest | null {
	const value = Object.values(exports).find(v => typeof v === 'object' && v !== null && 'id' in v && 'routes' in v && 'navItems' in v)
	return (value as ModuleManifest | undefined) ?? null
}

async function fromSources(): Promise<ModuleManifest[]> {
	// the modules' sources, next to the app (@hub-modules: build/sharedRuntime.ts, HUB_MODULES_DIR)
	const entries = import.meta.glob<Record<string, unknown>>('@hub-modules/*/manifest.tsx')
	const infos = import.meta.glob<ModuleDeclaration & { version: string, icon?: string, label: string, description?: string, isolated?: boolean }>('@hub-modules/*/module.json', { import: 'default', eager: true })
	for (const info of Object.values(infos)) declareModule(info)
	const models = import.meta.glob<ModelFile>('@hub-modules/*/models/*.json', { import: 'default', eager: true })
	for (const [path, model] of Object.entries(models)) {
		const id = path.split('/').at(-3)!
		registerModels(id, [model], Object.values(infos).find(i => i.id === id)?.formerly)
	}
	const modules = await Promise.all(Object.values(entries).map(load => load()))
	const manifests = modules.map(manifestOf).filter((m): m is ModuleManifest => m !== null)
	// the isolated hubbies: their frame, never their code
	for (const [path, info] of Object.entries(infos)) {
		if (!info.isolated) continue
		const id = path.split('/').at(-2)!
		MODULE_VERSIONS[id] = info.version
		manifests.push(isolatedManifest({ id, label: info.label, description: info.description }))
	}
	for (const m of manifests) {
		const info = Object.entries(infos).find(([path]) => path.split('/').at(-2) === m.id)?.[1]
		if (!info) continue
		MODULE_VERSIONS[m.id] = info.version
		// the store shows the icon module.json names before the module is installed
		if (m.icon && info.icon !== m.icon.iconName) console.warn(`[modules] ${m.id}: module.json names the icon "${info.icon}", the manifest shows "${m.icon.iconName}"`)
	}
	return manifests
}

async function fromBundles(): Promise<ModuleManifest[]> {
	const base = new URL('modules/', document.baseURI)
	let catalog: Array<ModuleDeclaration & { css: boolean, models?: boolean, version?: string }>
	try {
		catalog = (await import(/* @vite-ignore */ new URL('catalog.js', base).href)).default
	}
	catch (err) {
		console.error('[modules] no module catalogue', err)
		return []
	}
	const loaded = await Promise.all(catalog.map(async entry => {
		if (entry.version) MODULE_VERSIONS[entry.id] = entry.version
		// an isolated hubby: its frame, never its code in the app
		if ((entry as { isolated?: boolean }).isolated) {
			return loadModels(entry).then(() => isolatedManifest(entry as ModulePackage & { label: string }), err => {
				console.error(`[modules] ${entry.id} failed to load`, err)
				return null
			})
		}
		return loadBundle(entry)
	}))
	return loaded.filter((m): m is ModuleManifest => m !== null)
}

/**
 * What an installed module's collections seal (its models.json, checked with its files): before
 * its code can write any. An entry from before the `models` flag: asked anyway, absent then.
 */
async function loadModels(entry: ModuleDeclaration & { models?: boolean }): Promise<void> {
	const { id, models, formerly } = entry
	declareModule(entry)
	if (models === false) return
	const res = await fetch(new URL(`modules/${id}/models.json`, document.baseURI)).catch(() => null)
	if (res?.ok) registerModels(id, await res.json() as Record<string, ModelFile>, formerly)
	else if (models) throw new Error(`${id}: its models are missing`)
}

/** Loads an installed module's bundle (its models and styles first); null when it fails. */
async function loadBundle(entry: ModuleDeclaration & { css: boolean, models?: boolean }): Promise<ModuleManifest | null> {
	const { id, css } = entry
	const base = new URL('modules/', document.baseURI)
	try {
		await loadModels(entry)
		if (css && !document.head.querySelector(`link[data-module="${id}"]`)) {
			const link = document.createElement('link')
			link.rel = 'stylesheet'
			link.href = new URL(`${id}/style.css`, base).href
			link.dataset.module = id
			document.head.append(link)
		}
		const manifest = manifestOf(await import(/* @vite-ignore */ new URL(`${id}/index.js`, base).href))
		if (!manifest) console.error(`[modules] ${id}: no manifest exported`)
		return manifest
	}
	catch (err) {
		console.error(`[modules] ${id} failed to load`, err)
		return null
	}
}

/**
 * Front/server integrity enforcement. Every module (incl. the placeholders) now declares
 * a server ModuleInterface, so the diff is enforced: a manifest without server support is
 * hidden and logged (guards against desktop/server version skew). Placeholders still show
 * "coming soon" because their server stub advertises the capability. Local modules
 * (`local: true`) have no server side and are exempt.
 */
export const MODULE_INTEGRITY_ENFORCE = true

/** A module declared ahead of its pages: shown, but nothing to open yet. */
export function isComingSoon(m: ModuleManifest): boolean {
	return isInstalled(m) && m.navItems.length === 0 && m.routes.length === 0
}

/** Where a module opens: its home nav item, else its first page. */
export function moduleHomePath(m: ModuleManifest): string {
	return (m.navItems.find(i => i.home) ?? m.navItems[0])?.to ?? m.routes[0]?.path ?? `/${m.id}`
}
