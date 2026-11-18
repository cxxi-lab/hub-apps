import { useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router'
import { platform, type HubbyPackage, type RestrictedHubbyPackage } from '@platform'
import { api } from '@core/api/client'
import { describe, entryIcon, type HubbyInfo } from './describe'
import { HubbyHost } from '@core/hubby/HubbyHost'
import { registerModels, type ModelFile } from '@core/crypto/documents'
import { registerApi } from './apis'
import { declareHubby, type HubbyDeclaration } from './declarations'
import type { HubbyManifest } from './types'

export type { HubbyManifest, HubbyNavItem, HubbyRoute } from './types'

/** The catalogue order (top bar, home page, Settings); hubbies not listed come after. */
const ORDER = ['mail', 'ai', 'planner', 'memo', 'file-sharing', 'music', 'business', 'budget', 'workout']

/**
 * The hubby catalogue, in display order: the loaded hubbies, the ones published but not installed
 * on this device (stand-ins, see isInstalled). Filled by loadHubbies() before
 * the app renders (every window awaits it); it changes as hubbies get installed (useRegistry).
 */
export const HUBBY_MANIFESTS: HubbyManifest[] = []

/** The version of each loaded hubby (its hubby.json; the one actually loaded, built-in or downloaded). */
export const HUBBY_VERSIONS: Record<string, string> = {}

/** Stand-ins of the hubbies not installed here: listed (Settings) from their catalogue entry, no pages. */
const standIns = new WeakSet<HubbyManifest>()

/** Where each hubby's install stands on this device, while it is not loaded. */
export type InstallState = { phase: 'installing' } | { phase: 'error', error: string, at: number }
export const INSTALLS = new Map<string, InstallState>()

const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
	revision++
	for (const cb of listeners) cb()
}

/** Re-renders when the catalogue changes (a hubby installed, a published one listed); its revision. */
export function useRegistry(): number {
	return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => revision)
}

let loading: Promise<void> | null = null

/**
 * Loads the hubbies: from their sources in development (all of them, hot reload), from their
 * bundles in a build (hubbies/<id>/index.js and style.css, the ones installed here, listed by
 * hubbies/catalog.js, see scripts/build-hubbies.mjs). The published ones not installed are listed
 * next, without waiting (refreshStore). A hubby that fails to load is left out; the app goes on.
 */
export function loadHubbies(): Promise<void> {
	loading ??= (async () => {
		const loaded = import.meta.env.DEV ? await fromSources() : await fromBundles()
		place(loaded)
		void refreshStore()
	})()
	return loading
}

const rank = (id: string) => (ORDER.indexOf(id) + ORDER.length + 1) % (ORDER.length + 1)

/** Puts manifests in the catalogue (in place of the same hubby's), in display order. */
function place(manifests: HubbyManifest[]): void {
	for (const m of manifests) {
		const at = HUBBY_MANIFESTS.findIndex(known => known.id === m.id)
		if (at >= 0) HUBBY_MANIFESTS.splice(at, 1, m)
		else HUBBY_MANIFESTS.push(m)
	}
	HUBBY_MANIFESTS.sort((a, b) => rank(a.id) - rank(b.id))
}

/** Whether a hubby's pages are here (false: published, listed, not installed on this device). */
export function isInstalled(m: HubbyManifest): boolean {
	return !standIns.has(m)
}

function standIn(entry: HubbyPackage, icon = entryIcon(entry)): HubbyManifest {
	const m: HubbyManifest = {
		id: entry.id,
		label: entry.label ?? entry.id,
		description: entry.description,
		icon,
		local: entry.local,
		requires: entry.requires,
		requiresCapabilities: entry.requiresCapabilities as HubbyManifest['requiresCapabilities'],
		navItems: [],
		routes: []
	}
	standIns.add(m)
	return m
}

let storeRead = 0
/** how many hubbies the store listed (installed ones included), last time */
let storeListed = 0
let awaitingStore = false

/** Lists the published hubbies not installed here (stand-ins). Without the server: the last catalogue read. */
export async function refreshStore(): Promise<void> {
	const store = platform.hubbyStore
	if (!store) return
	// the restricted hubbies this account was given: listed by the server (with the session)
	await api<{ data: RestrictedHubbyPackage[] }>('/api/hub/hubbies/restricted')
		.then(res => store.setRestricted(res.data))
		.catch(err => console.warn('[hubbies] restricted hubbies not listed', err))
	try {
		const { hubbies } = await store.list()
		storeRead = Date.now()
		storeListed = hubbies.length
		const missing = hubbies.filter(e => !HUBBY_MANIFESTS.some(m => m.id === e.id && isInstalled(m)))
		if (missing.length === 0) return
		place(missing.map(e => standIn(e)))
		changed()
	}
	catch (err) {
		console.warn('[hubbies] store not listed', err)
	}
}

/** A failed install is tried again after this long (when still wanted). */
const RETRY_AFTER_MS = 30_000

/**
 * Installs and loads the hubbies wanted here (enabled) that are not installed yet; idempotent,
 * called whenever the wanted list may have changed. An id not listed yet waits for the store.
 */
export function installHubbies(ids: string[]): void {
	const store = platform.hubbyStore
	if (!store) return
	// enabled hubbies not listed while the store has listed nothing yet (the server out of reach at
	// the first start): ask it again, and come back. (Once it answered, an id it doesn't list is
	// not published for this app: left alone.)
	if (storeListed === 0 && ids.some(id => !HUBBY_MANIFESTS.some(m => m.id === id))) {
		if (Date.now() - storeRead > RETRY_AFTER_MS) void refreshStore()
		if (!awaitingStore) {
			awaitingStore = true
			setTimeout(() => { awaitingStore = false; changed() }, RETRY_AFTER_MS + 100)
		}
	}
	for (const id of ids) {
		const m = HUBBY_MANIFESTS.find(known => known.id === id)
		if (!m || isInstalled(m)) continue
		const state = INSTALLS.get(id)
		if (state?.phase === 'installing' || (state?.phase === 'error' && Date.now() - state.at < RETRY_AFTER_MS)) continue
		INSTALLS.set(id, { phase: 'installing' })
		changed()
		store.install(id)
			.then(async entry => {
				if (!(entry as { isolated?: boolean }).isolated) throw new Error(`${id} doesn't run isolated: not loaded`)
				await loadModels(entry)
				const manifest = isolatedManifest(entry as HubbyPackage & { label: string })
				HUBBY_VERSIONS[id] = entry.version
				INSTALLS.delete(id)
				place([manifest])
				changed()
			})
			.catch(err => {
				const error = err instanceof Error ? err.message : String(err)
				console.warn(`[hubbies] ${id} not installed`, error)
				INSTALLS.set(id, { phase: 'error', error, at: Date.now() })
				changed()
				// the windows want it again then (their effects call back here)
				setTimeout(changed, RETRY_AFTER_MS + 100)
			})
	}
}

/**
 * An isolated hubby's new version, switched to (store.activate([id])): its entry read again, its
 * models, its manifest in place of the former (its frame, a new component, mounts again). The
 * running version's entry when nothing changed. Throws for a hubby running in the app (its new
 * version runs at the next start).
 */
export async function reloadHubby(id: string): Promise<string> {
	const store = platform.hubbyStore
	if (!store) throw new Error('no hubby store here')
	const entry = await store.install(id)
	if (!(entry as { isolated?: boolean }).isolated) throw new Error(`${id} runs in the app: its new version at the next start`)
	await loadModels(entry)
	place([isolatedManifest(entry as HubbyPackage & { label: string })])
	HUBBY_VERSIONS[id] = entry.version
	changed()
	return entry.version
}

/** Removes a hubby from this device (a disabled one); it is listed again as not installed. */
export async function uninstallHubby(id: string): Promise<void> {
	const store = platform.hubbyStore
	const m = HUBBY_MANIFESTS.find(known => known.id === id)
	if (!store || !m || !isInstalled(m)) return
	await store.uninstall(id)
	delete HUBBY_VERSIONS[id]
	const { label, description, local, requires, requiresCapabilities } = m
	place([standIn({ id, version: '', sdk: '', css: false, label, description, local, requires, requiresCapabilities }, m.icon)])
	changed()
}

/**
 * An isolated hubby's manifest (docs/plan-hubby-architecture.md § 4 ter): none of its code runs in
 * the app; one route, /<id> and everything under it, shows its frame; its navigation is the one
 * the frame announces.
 */
function isolatedManifest(entry: { id: string, label: string, description?: string, icon?: HubbyPackage['icon'], version?: string, settingsPage?: unknown }): HubbyManifest {
	const Page = () => <HubbyHost hubby={entry.id} />
	// its own settings are a page of its frame (hubby.json `settingsPage`): its part of the Hubbies
	// screen opens it (a frame can't open a modal over the app from inside that screen)
	const settingsPage = typeof entry.settingsPage === 'string' && entry.settingsPage.startsWith(`/${entry.id}/`) ? entry.settingsPage : null
	return {
		...(settingsPage ? { Settings: () => <SettingsLink label={entry.label} to={settingsPage} /> } : {}),
		id: entry.id,
		// what its hubby.json says the app enforces (local, the shell's capabilities, the VPN…)
		...describe({ version: entry.version ?? '', sdk: '', ...(entry as Partial<HubbyInfo>), label: entry.label }),
		icon: entry.icon ? entryIcon(entry as HubbyPackage) : undefined,
		isolated: true,
		navItems: [],
		routes: [{ path: `/${entry.id}`, Component: Page, persistent: true, prefix: true }]
	}
}

function SettingsLink({ label, to }: { label: string, to: string }) {
	const navigate = useNavigate()
	return (
		<button
			type="button"
			onClick={() => navigate(to)}
			className="self-start h-9 px-4 rounded border border-steel-700 bg-steel-800 hover:bg-steel-700 text-sm text-steel-100 cursor-pointer"
		>
			Open {label}'s settings
		</button>
	)
}

/** Every hubby runs isolated (docs/plan-isolation.md): one that doesn't isn't loaded. */
function refused(id: string): null {
	console.error(`[hubbies] ${id} doesn't run isolated: not loaded (a hubby runs in its frame, hubby.json "isolated": true)`)
	return null
}

async function fromSources(): Promise<HubbyManifest[]> {
	// the hubbies' sources, next to the app (@hub-hubbies: build/sharedRuntime.ts, HUB_HUBBIES_DIR):
	// their hubby.json and models; their frames load their built files
	const infos = import.meta.glob<HubbyDeclaration & { version: string, icon?: string, label: string, description?: string, isolated?: boolean }>('@hub-hubbies/*/hubby.json', { import: 'default', eager: true })
	for (const info of Object.values(infos)) declareHubby(info)
	const models = import.meta.glob<ModelFile>('@hub-hubbies/*/models/*.json', { import: 'default', eager: true })
	for (const [path, model] of Object.entries(models)) {
		const id = path.split('/').at(-3)!
		registerModels(id, [model])
	}
	// their APIs (docs/plan-api-hubbies.md)
	const apis = import.meta.glob<Parameters<typeof registerApi>[1]>('@hub-hubbies/*/api.json', { import: 'default', eager: true })
	const apiDocs = import.meta.glob<string>('@hub-hubbies/*/api.md', { query: '?raw', import: 'default', eager: true })
	for (const [path, api] of Object.entries(apis)) registerApi(path.split('/').at(-2)!, api, apiDocs[path.replace(/api\.json$/, 'api.md')] ?? null)
	const manifests: HubbyManifest[] = []
	for (const [path, info] of Object.entries(infos)) {
		const id = path.split('/').at(-2)!
		if (!info.isolated) { refused(id); continue }
		HUBBY_VERSIONS[id] = info.version
		manifests.push(isolatedManifest({ ...info, id, icon: undefined }))
	}
	return manifests
}

async function fromBundles(): Promise<HubbyManifest[]> {
	const base = new URL('modules/', document.baseURI)
	let catalog: Array<HubbyDeclaration & { css: boolean, models?: boolean, version?: string }>
	try {
		catalog = (await import(/* @vite-ignore */ new URL('catalog.js', base).href)).default
	}
	catch (err) {
		console.error('[hubbies] no hubby catalogue', err)
		return []
	}
	const loaded = await Promise.all(catalog.map(async entry => {
		if (entry.version) HUBBY_VERSIONS[entry.id] = entry.version
		// its frame, never its code in the app
		if (!(entry as { isolated?: boolean }).isolated) return refused(entry.id)
		return loadModels(entry).then(() => isolatedManifest(entry as HubbyPackage & { label: string }), err => {
			console.error(`[hubbies] ${entry.id} failed to load`, err)
			return null
		})
	}))
	return loaded.filter((m): m is HubbyManifest => m !== null)
}

/**
 * What an installed hubby's collections seal (its models.json, checked with its files): before
 * its code can write any. An entry from before the `models` flag: asked anyway, absent then.
 */
async function loadModels(entry: HubbyDeclaration & { models?: boolean, api?: boolean }): Promise<void> {
	const { id, models } = entry
	declareHubby(entry)
	// its API for the other hubbies (docs/plan-api-hubbies.md): unknown to them without it
	if (entry.api === true) {
		const res = await fetch(new URL(`modules/${id}/api.json`, document.baseURI)).catch(() => null)
		const doc = await fetch(new URL(`modules/${id}/api.md`, document.baseURI)).then(r => r.ok ? r.text() : null, () => null)
		if (res?.ok) registerApi(id, await res.json() as Parameters<typeof registerApi>[1], doc)
		else console.warn(`[hubbies] ${id}: its api.json is missing`)
	}
	if (models === false) return
	const res = await fetch(new URL(`modules/${id}/models.json`, document.baseURI)).catch(() => null)
	if (res?.ok) registerModels(id, await res.json() as Record<string, ModelFile>)
	else if (models) throw new Error(`${id}: its models are missing`)
}

/**
 * Front/server integrity enforcement: a manifest the server doesn't list (its registry) is
 * hidden (guards against app/server version skew). Local hubbies (`local: true`) have no server
 * side and are exempt.
 */
export const HUBBY_INTEGRITY_ENFORCE = true

/** Where a hubby opens: its home nav item, else its first page. */
export function hubbyHomePath(m: HubbyManifest): string {
	return (m.navItems.find(i => i.home) ?? m.navItems[0])?.to ?? m.routes[0]?.path ?? `/${m.id}`
}
