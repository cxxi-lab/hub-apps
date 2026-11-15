import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { platform } from '@platform'
import { faBell, faCode, faMobileScreenButton, faLink, faLock, faPalette } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { SettingsConnections } from '@core/settings/SettingsConnections'
import { SettingsDevices } from '@core/settings/SettingsDevices'
import { SettingsNotifications } from '@core/settings/SettingsNotifications'
import { SettingsSecurity } from '@core/settings/SettingsSecurity'
import { SettingsTheme } from '@core/settings/SettingsTheme'
import { SettingsDeveloper } from '@core/settings/SettingsDeveloper'

interface Section {
	id: string
	label: string
	icon: typeof faLock
	/** `sub`: a screen inside the section (target 'section/sub') */
	component: (sub?: string) => React.ReactNode
	/** draws its own title (a section with sub-screens) */
	ownTitle?: boolean
}

const SECTIONS: Section[] = [
	{ id: 'security', label: 'Security', icon: faLock, component: () => <SettingsSecurity /> },
	{ id: 'devices', label: 'Devices', icon: faMobileScreenButton, component: () => <SettingsDevices /> },
	{ id: 'connections', label: 'Connections', icon: faLink, component: () => <SettingsConnections /> },
	{ id: 'notifications', label: 'Notifications', icon: faBell, component: () => <SettingsNotifications /> },
	{ id: 'theme', label: 'Theme', icon: faPalette, component: () => <SettingsTheme /> },
	{ id: 'developer', label: 'Developer', icon: faCode, component: () => <SettingsDeveloper /> },
]

export function SettingsApp() {
	// The screen asked for when opening ('security'), then by the other windows.
	const [initial] = useState(() => parseTarget(new URLSearchParams(window.location.search).get('screen')))
	const [active, setActive] = useState(initial?.section ?? SECTIONS[0].id)
	const [sub, setSub] = useState<string | undefined>(initial?.sub)
	// Bumped on every click in the sidebar or request: the section starts over on its screen.
	const [visit, setVisit] = useState(0)

	useEffect(() => platform.onSettingsGoto(target => {
		const parsed = parseTarget(target)
		if (!parsed) return
		setActive(parsed.section)
		setSub(parsed.sub)
		setVisit(v => v + 1)
	}), [])
	const current = SECTIONS.find(s => s.id === active) ?? SECTIONS[0]

	const itemClass = (isActive: boolean) => [
		'flex items-center gap-3 relative py-2 pl-6 pr-8 text-sm/[1] cursor-pointer border-0 bg-transparent text-left transition',
		isActive
			? 'text-primary-500 bg-primary-700 before:absolute before:bg-primary-500 before:w-1 before:left-0 before:inset-y-0'
			: 'text-steel-100 hover:text-white hover:bg-steel-700'
	].join(' ')

	return (
		<div className="flex h-screen bg-steel-950 text-steel-100">
			<aside className="w-48 shrink-0 flex flex-col bg-steel-900 border-r border-steel-700 py-4">
				<div className="px-6 mb-3 text-[10px] font-bold uppercase tracking-[1.5px] text-steel-500">
					Settings
				</div>
				{SECTIONS.map(s => (
					<button
						key={s.id}
						type="button"
						onClick={() => { setActive(s.id); setSub(undefined); setVisit(v => v + 1) }}
						className={itemClass(s.id === active)}
					>
						<FontAwesomeIcon icon={s.icon} className="w-4 shrink-0" />
						{s.label}
					</button>
				))}
			</aside>

			<main className="flex-1 min-w-0 overflow-y-auto p-6">
				{!current.ownTitle && <h1 className="text-xl font-semibold text-white mb-6">{current.label}</h1>}
				<div key={`${current.id}:${visit}`}>{current.component(sub)}</div>
			</main>
		</div>
	)
}

/**
 * Settings as a page of the app (/settings[/<section>[/<screen>]]), for the shells without a
 * Settings window (Android): the sections as tabs above, the screen below.
 */
export function SettingsPage() {
	const location = useLocation()
	const navigate = useNavigate()
	const target = parseTarget(location.pathname.replace(/^\/settings\/?/, '') || null)
	const current = SECTIONS.find(s => s.id === target?.section) ?? SECTIONS[0]

	return (
		<div className="flex-1 min-h-0 flex flex-col">
			<nav className="shrink-0 flex gap-1 px-4 overflow-x-auto border-b border-steel-700 [scrollbar-width:none]">
				{SECTIONS.map(s => (
					<button
						key={s.id}
						type="button"
						onClick={() => navigate(`/settings/${s.id}`)}
						className={`relative flex items-center gap-2 h-11 px-3 shrink-0 border-0 bg-transparent text-sm cursor-pointer ${s.id === current.id
							? 'text-white after:absolute after:bottom-0 after:inset-x-2 after:h-[3px] after:bg-primary-500 after:rounded-t-[1px]'
							: 'text-steel-300 hover:text-white'}`}
					>
						<FontAwesomeIcon icon={s.icon} className="w-4" />
						{s.label}
					</button>
				))}
			</nav>
			<main className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6">
				<div key={current.id}>{current.component(target?.sub)}</div>
			</main>
		</div>
	)
}

/** 'section/sub' → the section, on that screen. */
function parseTarget(target: string | null): { section: string, sub?: string } | null {
	if (!target) return null
	const [section, sub] = target.split('/')
	return SECTIONS.some(s => s.id === section) ? { section, sub } : null
}
