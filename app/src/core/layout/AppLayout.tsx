import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { faCube, faCubes, faPlus, faPuzzlePiece, type IconDefinition } from '@fortawesome/free-solid-svg-icons'
import { hideAll, reveal, setBlurredModules, setHiddenModules, useHiddenModules, useRevealedModules } from '@core/privacy/hidden'
import { KeepAlive } from '@core/layout/KeepAlive'
import { TopBar } from '@core/layout/TopBar'
import { ModuleUpdates } from '@core/module/ModuleUpdates'
import { ModuleNav } from '@core/layout/ModuleNav'
import { useHubbyNavs } from '@core/hubby/navs'
import { installModules, MODULE_MANIFESTS, useRegistry } from '@core/module/registry'
import type { ModuleManifest } from '@core/module/types'
import { enabledModules, wantedIds } from '@core/module/visibility'
import { fetchModulesState, onModulesChange, type ModulesState } from '@core/api/modules'
import { ModulesContext } from '@core/contexts/ModulesContext'
import { ModulesPage } from '@core/modules/ModulesPage'
import { SettingsPage } from '@core/settings/SettingsApp'
import { platform } from '@platform'
import { startNotifications } from '@core/notifications/notifications'
import { SystemNotifications } from '@core/notifications/SystemNotifications'
import { TunnelGate } from '@core/vpn/TunnelGate'
import { LockGate } from '@core/privacy/LockGate'

// Kept for TopBar's prop shape (built from the module manifests).
export interface NavItem {
	to: string; label: string; Label?: ComponentType; section?: string; home?: boolean; icon?: IconDefinition
	/** active on this path only, not on the ones under it */
	end?: boolean
}
export interface NavDomain {
	id: string
	label: string
	requiresPrivate?: boolean
	items: NavItem[]
	icon?: IconDefinition
	sections?: Record<string, IconDefinition>
}

// Always-present shell pages (not modules).
const CORE_SHELL_PAGES: { path: string; Component: ComponentType }[] = [
	{ path: '/modules', Component: ModulesPage },
	// the shells without a Settings window (Android): Settings as a page
	{ path: '/settings', Component: SettingsPage }
]
/** A shell page's path, or one of its screens (/modules/mail). */
const isCorePath = (pathname: string) => CORE_SHELL_PAGES.some(p => pathname === p.path || pathname.startsWith(`${p.path}/`))

/** a reveal shortcut is sent once no key came for this long (Ctrl+Alt still held or not) */
const SHORTCUT_PAUSE_MS = 900
const SHORTCUT_KEY = /^[a-z0-9]$/

export function AppLayout() {
	const location = useLocation()
	const navigate = useNavigate()
	const revealed = useRevealedModules()
	const hidden = useHiddenModules()

	// Desktop owns the module catalogue (manifests); the server advertises which modules
	// it can serve (`available`) and which the user enabled. Default = all enabled (null)
	// so the UI is populated before the fetch resolves.
	// (the hidden ones: as last read, so that none shows before the server answers)
	const [modules, setModules] = useState<ModulesState>(() => ({ available: [], enabled: null, pinned: [], hidden }))

	useEffect(() => {
		if (modules.hidden) setHiddenModules(modules.hidden)
	}, [modules.hidden])

	useEffect(() => {
		if (modules.blurred) setBlurredModules(modules.blurred)
	}, [modules.blurred])

	// The notifications, kept live for the top bar and its menu.
	useEffect(() => startNotifications(), [])

	// Fetched at boot, then kept in step with the Settings window (announced changes, and a refetch
	// whenever this window comes back to the front).
	useEffect(() => {
		let alive = true
		const load = () => fetchModulesState()
			.then(state => { if (alive) setModules(state) })
			.catch(() => { /* keep what we have (optimistic defaults at boot) */ })
		load()
		const off = onModulesChange(state => { if (alive) setModules(state) })
		window.addEventListener('focus', load)
		return () => {
			alive = false
			off()
			window.removeEventListener('focus', load)
		}
	}, [])

	// Front/server integrity diff — guards against version skew (desktop auto-updates
	// while the server is deployed manually).
	useEffect(() => {
		if (modules.available.length === 0) return // server hasn't reported (or migration in progress)
		const frontIds = MODULE_MANIFESTS.filter(m => !m.local).map(m => m.id)
		const frontOnly = frontIds.filter(id => !modules.available.includes(id))
		const serverOnly = modules.available.filter(id => !frontIds.includes(id))
		if (frontOnly.length) console.warn('[modules] manifest without server support — update the server:', frontOnly)
		if (serverOnly.length) console.warn('[modules] server module without a desktop manifest — update the desktop:', serverOnly)
	}, [modules])

	// The catalogue changes as modules get installed (and as the store lists the others).
	const registry = useRegistry()

	// Enabled modules in the user's order: the home page and the routes mounted (the top bar: the pinned ones).
	const visibleModules = useMemo(() => enabledModules(modules, revealed), [modules, revealed, registry])

	// An enabled module this device doesn't have yet is installed, then shown (on every device).
	useEffect(() => {
		installModules(wantedIds(modules, revealed))
	}, [modules, revealed, registry])

	// The routes of the hidden modules not revealed: left at once (Ctrl+Alt+Q on one of their pages).
	const hiddenRoutes = useMemo(
		() => new Set(MODULE_MANIFESTS.filter(m => (modules.hidden ?? []).includes(m.id) && !revealed.includes(m.id)).flatMap(m => m.routes.map(r => r.path))),
		[registry, modules.hidden, revealed]
	)

	// an isolated hubby's navigation: the one its frame announced
	const hubbyNavs = useHubbyNavs()
	const domains: NavDomain[] = useMemo(
		() => visibleModules.map(m => m.isolated
			? { id: m.id, label: m.label, items: hubbyNavs[m.id]?.items ?? [], icon: m.icon, sections: hubbyNavs[m.id]?.sections as NavDomain['sections'] }
			: { id: m.id, label: m.label, items: m.navItems, icon: m.icon, sections: m.navSections }),
		[visibleModules, hubbyNavs]
	)


	// The windows of the active modules, for the app menu (desktop): the menu offers a module's
	// windows only while it is active.
	useEffect(() => {
		if (!platform.capabilities.nativeWindows) return
		platform.registerModuleWindows(visibleModules.flatMap(m => (m.windows ?? []).map(w => ({
			moduleId: m.id, id: w.id, title: w.title, width: w.width, height: w.height, menu: w.menu
		})))).catch(err => console.warn('[modules] windows not registered', err))
	}, [visibleModules])

	const registeredPaths = useMemo(
		() => new Set([...CORE_SHELL_PAGES.map(p => p.path), ...visibleModules.flatMap(m => m.routes.map(r => r.path))]),
		[visibleModules]
	)

	const activeDomain = domains.find(d => {
		// Sub-pages (e.g. a conversation under its list) keep their domain active.
		// /<id>/… is always the module's (an isolated hubby's pages are all under it)
		if (location.pathname === `/${d.id}` || location.pathname.startsWith(`/${d.id}/`)) return true
		return d.items.some(i => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`))
	}) ?? null

	// The Modules screen's sidebar: its page, then a direct link to each enabled module's settings.
	const modulesNav: NavItem[] = useMemo(() => [
		{ to: '/modules', label: 'Installed', end: true, icon: faCubes },
		...visibleModules.map(m => ({ to: `/modules/${m.id}`, label: m.label, section: 'Modules', icon: m.icon ?? faCube }))
	], [visibleModules])
	const onModulesScreen = location.pathname === '/modules' || location.pathname.startsWith('/modules/')

	// The top bar: the pinned modules, plus the one open (its tab marks where you are).
	const topBarDomains = useMemo(
		() => domains.filter(d => modules.pinned.includes(d.id) || d.id === activeDomain?.id),
		[domains, modules.pinned, activeDomain?.id]
	)

	// A page of a module just disabled (or of none): back to the home page.
	useEffect(() => {
		if (location.pathname !== '/' && !activeDomain && !isCorePath(location.pathname)) navigate('/', { replace: true })
	}, [location.pathname, activeDomain, navigate])

	useEffect(() => {
		if (hiddenRoutes.has(location.pathname)) {
			navigate('/', { replace: true })
		}
	}, [hiddenRoutes, location.pathname, navigate])

	// The reveal shortcuts: letters and digits typed with Ctrl+Alt held, sent to the server once
	// they stop (it alone knows the shortcuts); Ctrl+Alt+Q hides every revealed module again.
	useEffect(() => {
		let keys = ''
		let timer: ReturnType<typeof setTimeout> | null = null

		const send = () => {
			timer = null
			const typed = keys
			keys = ''
			if (typed.length >= 3) void reveal(typed).catch(err => console.warn('[privacy] reveal failed', err))
		}

		const handleKey = (rawKey: string, ctrl: boolean, alt: boolean): void => {
			if (!ctrl || !alt || rawKey === 'Control' || rawKey === 'Alt') return
			const key = rawKey.toLowerCase()
			if (key === 'q') {
				keys = ''
				if (timer) clearTimeout(timer)
				timer = null
				hideAll()
				return
			}
			if (!SHORTCUT_KEY.test(key)) return
			keys = (keys + key).slice(-16)
			if (timer) clearTimeout(timer)
			timer = setTimeout(send, SHORTCUT_PAUSE_MS)
		}

		const onKeyDown = (e: KeyboardEvent) => {
			handleKey(e.key, e.ctrlKey, e.altKey)
		}

		window.addEventListener('keydown', onKeyDown)
		const unsubWebview = platform.onWebviewKey(({ key, ctrl, alt }) => handleKey(key, ctrl, alt))

		return () => {
			window.removeEventListener('keydown', onKeyDown)
			if (timer) clearTimeout(timer)
			unsubWebview()
		}
	}, [])

	return (
		<ModulesContext value={visibleModules}>
		<div className="flex flex-col h-[calc(100vh-var(--status-bar-height))]">
			<SystemNotifications />
			<TopBar domains={topBarDomains} activeDomainId={activeDomain?.id ?? null} />
			<ModuleUpdates />
			{/* on phones the module nav is a bar under the content (column, the bar last) */}
			<div className="relative flex-1 flex max-sm:flex-col min-h-0 overflow-hidden">
				{activeDomain && activeDomain.items.length > 0 && (
					<ModuleNav items={activeDomain.items} icon={activeDomain.icon} sections={activeDomain.sections} />
				)}
				{onModulesScreen && (
					<ModuleNav
						items={modulesNav}
						icon={faCubes}
						sections={{ Modules: faPuzzlePiece }}
						action={{ label: 'Add a module', icon: faPlus, onClick: () => navigate({ pathname: '/modules', search: '?add' }) }}
					/>
				)}
				<main className="relative flex-1 min-w-0 min-h-0 flex flex-col">
					{activeDomain && activeDomain.items.length === 0 && !registeredPaths.has(location.pathname) && !visibleModules.some(m => m.routes.some(r => routeMatches(r, location.pathname))) && (
						<div className="flex-1 flex items-center justify-center text-steel-300 text-sm">
							<span>{activeDomain.label} — coming soon</span>
						</div>
					)}
					{/* shell pages: mounted while shown (read afresh each visit) */}
					{CORE_SHELL_PAGES.map(({ path, Component }) => (
						(location.pathname === path || location.pathname.startsWith(`${path}/`)) && <Component key={path} />
					))}
					{visibleModules.map(m => (
						<ModulePages key={m.id} module={m} pathname={location.pathname} locked={(modules.locked ?? []).includes(m.id)} />
					))}
					<Outlet />
				</main>
			</div>
		</div>
		</ModulesContext>
	)
}

/**
 * A module's pages, inside the contexts it declared (`providers`, one instance shared by its pages):
 * persistent pages stay mounted once visited (KeepAlive), the others only while shown. Scoped per
 * module, a module coming or going (private mode) leaves the other modules' pages as they are.
 */
/** Does a route answer this path (its own, or one under it for a prefix route)? */
function routeMatches(route: ModuleManifest['routes'][number], pathname: string): boolean {
	return pathname === route.path || (!!route.prefix && pathname.startsWith(`${route.path}/`))
}

function ModulePages({ module, pathname, locked }: { module: ModuleManifest, pathname: string, locked: boolean }) {
	const pages = module.routes.map(route => route.persistent
		? <KeepAlive key={route.path} when={routeMatches(route, pathname)}><route.Component /></KeepAlive>
		: routeMatches(route, pathname) ? <route.Component key={route.path} /> : null)
	const active = module.routes.some(r => routeMatches(r, pathname))
	// a module on the VPN: its pages behind the tunnel, run while it is open
	const tunneled = module.supports?.includes('vpn') && platform.capabilities.vpn
		? <TunnelGate module={module.id} active={active}>{pages}</TunnelGate>
		: <>{pages}</>
	// a locked one: behind its password first (nothing of it loads before)
	const content = locked
		? <LockGate module={module.id} label={module.label} active={active}>{tunneled}</LockGate>
		: tunneled
	return (module.providers ?? []).reduceRight<ReactNode>((inner, Provider) => <Provider>{inner}</Provider>, content)
}
