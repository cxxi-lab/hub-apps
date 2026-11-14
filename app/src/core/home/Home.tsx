import type { KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faCube } from '@fortawesome/free-solid-svg-icons'
import { useModules } from '@core/contexts/ModulesContext'
import { INSTALLS, isComingSoon, isInstalled, MODULE_MANIFESTS, moduleHomePath, useRegistry, type InstallState } from '@core/module/registry'
import type { ModuleManifest } from '@core/module/types'

/** The home page: the enabled modules as cards, in their order (pinning one to the top bar: its settings). */
export function Home() {
	const modules = useModules()
	useRegistry()
	// enabled modules on their way to this device (shown once installed)
	const installing = MODULE_MANIFESTS.filter(m => !isInstalled(m) && INSTALLS.has(m.id))

	return (
		<div className="flex-1 min-h-0 overflow-y-auto">
			<div className="max-w-[70rem] px-20 max-lg:px-10 max-sm:px-4">
				<ul className="mt-12 mb-12 max-sm:mt-4 p-0 list-none grid grid-cols-2 gap-3 sm:gap-6">
					{modules.filter(m => !isComingSoon(m)).map(m => (
						<li key={m.id}>
							<ModuleCard module={m} />
						</li>
					))}
					{installing.map(m => (
						<li key={m.id}>
							<ModuleCard module={m} install={INSTALLS.get(m.id)} />
						</li>
					))}
				</ul>
			</div>
		</div>
	)
}

// The cards of the first hub's product pages: a primary tile, no border, a lift on hover (shadow-raised).

function ModuleCard({ module: m, install }: { module: ModuleManifest, install?: InstallState }) {
	const navigate = useNavigate()
	const soon = isComingSoon(m) || !!install
	const badge = install?.phase === 'installing' ? 'Installing…' : install?.phase === 'error' ? 'Install failed' : 'Coming soon'

	const open = () => { if (!soon) navigate(moduleHomePath(m)) }
	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
		e.preventDefault()
		open()
	}

	return (
		<div
			role={soon ? undefined : 'link'}
			tabIndex={soon ? undefined : 0}
			onClick={open}
			onKeyDown={onKeyDown}
			className={[
				'h-full flex flex-col gap-3 sm:gap-4 p-4 sm:p-6 rounded bg-steel-800 text-steel-100 outline-none transition-shadow duration-200 shadow-raised',
				soon ? 'opacity-50' : 'cursor-pointer hover:shadow-raised-hover focus-visible:shadow-raised-focus'
			].join(' ')}
		>
			<div className="flex items-start justify-between gap-3">
				<span className="size-10 sm:size-12 shrink-0 flex items-center justify-center rounded bg-primary-500 text-steel-800">
					<FontAwesomeIcon icon={m.icon ?? faCube} className="text-lg sm:text-xl" />
				</span>
				{soon && (
					<span
						title={install?.phase === 'error' ? install.error : undefined}
						className="px-2 py-0.5 rounded bg-steel-800 text-[10px] uppercase tracking-[1.5px] text-steel-300"
					>
						{badge}
					</span>
				)}
			</div>
			<div className="min-w-0">
				<h3 className="m-0 text-lg sm:text-2xl font-medium text-white truncate">{m.label}</h3>
				{m.description && <p className="mt-1 mb-0 max-sm:text-xs">{m.description}</p>}
			</div>
		</div>
	)
}
