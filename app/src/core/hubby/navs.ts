import { useSyncExternalStore } from 'react'
import type { NavItem } from '@core/layout/AppLayout'
import type { HubbyPage } from '@cxxi-lab/hubbyware-sdk/protocol'

/**
 * The navigation of the isolated hubbies, as each one's frame announced it (its `register`): the
 * host builds the column / bottom bar from it like a hubby's own.
 */

let navs: Record<string, { items: NavItem[], sections: Record<string, unknown> }> = {}
const listeners = new Set<() => void>()

export function setHubbyNav(hubby: string, pages: HubbyPage[], sections: Record<string, unknown>): void {
	const items: NavItem[] = pages.filter(p => p.section !== undefined).map(p => ({
		to: `/${hubby}${p.path === '/' ? '' : p.path}`,
		label: p.title ?? p.path,
		section: p.section || undefined,
		icon: p.icon as NavItem['icon'],
		end: true
	}))
	navs = { ...navs, [hubby]: { items, sections } }
	listeners.forEach(l => l())
}

export function useHubbyNavs() {
	return useSyncExternalStore(
		l => { listeners.add(l); return () => listeners.delete(l) },
		() => navs
	)
}
