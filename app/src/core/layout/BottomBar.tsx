import { useEffect, useState, type ComponentType } from 'react'
import { useLocation } from 'react-router'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { useBackHandler } from '@cxxi-lab/hub-ui'

/** An entry of a tab's menu. */
export interface BottomBarEntry {
	key: string
	label: string
	/** a live label rendered instead of `label` (in the menu) */
	Label?: ComponentType
	icon?: IconDefinition
	active: boolean
	onClick: () => void
	/** a dot: something new there */
	dot?: boolean
	/** a count beside it in the menu (e.g. unread) */
	count?: number
}

/**
 * A tab of the bottom bar: an action of its own (`primary`: the page's main action, a round button
 * in the brand colour, e.g. Mail's new message), or a menu opening upwards (its entries in groups,
 * under an optional title). An active menu tab stands for its active entry (its icon and label,
 * highlighted) unless `fixed`: e.g. Mail's "+" while one of its folders is open.
 */
export type BottomBarTab =
	| { key: string, label: string, icon: IconDefinition, active: boolean, onClick: () => void, dot?: boolean, primary?: boolean }
	| { key: string, label: string, icon: IconDefinition, menu: { title?: string, entries: BottomBarEntry[] }[], fixed?: boolean }

const tabClass = (active: boolean) => [
	// contents at the bottom: every label on one line, the round button's included
	'relative flex-1 min-w-0 flex flex-col items-center justify-end gap-1.5 pb-2 px-1 bg-transparent border-0 cursor-pointer no-underline',
	'text-[10px] leading-none transition-colors',
	active
		? 'text-primary-500 before:absolute before:top-0 before:inset-x-4 before:h-0.5 before:rounded-b before:bg-primary-500'
		: 'text-steel-300'
].join(' ')

const Dot = () => <span className="absolute -top-0.5 -right-1.5 size-1.5 rounded-full bg-product-red" />

/**
 * The phone's bottom bar, like Android's: a module's pages (ModuleNav), or a page's own places
 * (Mail's folders). A menu closes on a choice, on back, on a tap beside it, on navigation.
 */
export function BottomBar({ tabs }: { tabs: BottomBarTab[] }) {
	const { pathname } = useLocation()
	const [menu, setMenu] = useState<string | null>(null)
	useBackHandler(menu !== null, () => setMenu(null))
	useEffect(() => { setMenu(null) }, [pathname])

	const opened = tabs.find(t => t.key === menu)

	return (
		<nav className="order-last relative shrink-0 flex h-14 box-content pb-[env(safe-area-inset-bottom)] bg-steel-950 border-t border-steel-700 select-none">
			{/* the content fades out as it reaches the bar */}
			<div aria-hidden className="absolute z-10 inset-x-0 bottom-full h-12 bg-linear-to-t from-steel-950 to-transparent pointer-events-none" />
			{tabs.map(tab => {
				if (!('menu' in tab) && tab.primary) {
					// inside the bar (it clips what goes past), centred; no label (aria-label only)
					return (
						<button
							key={tab.key}
							type="button"
							onClick={tab.onClick}
							aria-label={tab.label}
							className="flex-1 min-w-0 flex items-center justify-center px-1 bg-transparent border-0 cursor-pointer"
						>
							<span className="size-11 rounded-full flex items-center justify-center bg-primary-500 text-steel-950 shadow-[0_2px_8px_rgba(0,0,0,0.5)]">
								<FontAwesomeIcon icon={tab.icon} className="text-base" />
							</span>
						</button>
					)
				}
				const entries = 'menu' in tab ? tab.menu.flatMap(g => g.entries) : []
				const current = 'menu' in tab && !tab.fixed ? entries.find(e => e.active) : undefined
				const active = 'menu' in tab ? entries.some(e => e.active) : tab.active
				const dot = 'menu' in tab ? entries.some(e => e.dot) : tab.dot
				const onClick = 'menu' in tab ? () => setMenu(menu === tab.key ? null : tab.key) : tab.onClick
				return (
					<button key={tab.key} type="button" onClick={onClick} className={tabClass(active || menu === tab.key)} aria-current={active ? 'page' : undefined}>
						<span className="relative">
							<FontAwesomeIcon icon={current?.icon ?? tab.icon} className="text-base" />
							{dot && <Dot />}
						</span>
						<span className="max-w-full truncate">{current ? current.label : tab.label}</span>
					</button>
				)
			})}

			{opened && 'menu' in opened && (
				<>
					<button type="button" aria-label="Close menu" onClick={() => setMenu(null)} className="fixed inset-0 z-40 bg-black/40 border-0 cursor-default" />
					<div className="absolute bottom-full inset-x-2 mb-2 z-50 max-h-[60vh] overflow-y-auto py-2 bg-steel-900 border border-steel-700 rounded-md shadow-[0_-4px_16px_rgba(0,0,0,0.5)]">
						{opened.menu.map((group, i) => (
							<div key={group.title ?? i} className="flex flex-col">
								{group.title && (
									<div className="px-4 pt-2 pb-1 text-[10px] font-bold uppercase tracking-[1.5px] text-steel-500">{group.title}</div>
								)}
								{group.entries.map(entry => (
									<button
										key={entry.key}
										type="button"
										onClick={() => { setMenu(null); entry.onClick() }}
										className={`flex items-center gap-3 px-4 h-11 text-sm text-left border-0 cursor-pointer ${entry.active ? 'text-primary-500 bg-primary-700' : 'text-steel-100 bg-transparent'}`}
									>
										{entry.icon && <FontAwesomeIcon icon={entry.icon} className="w-4 text-steel-300" />}
										<span className="flex-1 min-w-0 truncate">{entry.Label ? <entry.Label /> : entry.label}</span>
										{!!entry.count && <span className="shrink-0 text-xs text-steel-300 tabular-nums">{entry.count}</span>}
										{entry.dot && <span className="size-1.5 rounded-full bg-product-red" />}
									</button>
								))}
							</div>
						))}
					</div>
				</>
			)}
		</nav>
	)
}
