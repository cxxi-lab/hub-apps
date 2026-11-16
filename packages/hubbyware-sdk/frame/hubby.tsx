import { createElement, StrictMode, type ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { HubbyPage } from '../protocol'
import { connect, register, usePath } from './sdk'

/**
 * A hubby's front (docs/spec-hubby.md § 6): its pages, each a component; those with a `nav`
 * section make its navigation (built by the host: the column on desktop, the bottom bar on phones).
 */
export interface HubbyPageDefinition {
	/** relative to the hubby: '/', '/settings', '/:id' */
	path: string
	component: ComponentType<{ params: Record<string, string> }>
	title?: string
	icon?: unknown
	nav?: { section?: string }
}

export interface HubbyDefinition {
	pages: HubbyPageDefinition[]
	/** the sections' icons in the navigation, by title */
	navSections?: Record<string, unknown>
}

export function defineHubby(definition: HubbyDefinition): HubbyDefinition {
	return definition
}

/** @deprecated defineHubby: its SDK 2 name, kept for the hubbies built before the rename */
export const defineModule = defineHubby

/** The page matching a path, with its parameters (`:name` segments). */
export function match(pages: HubbyPageDefinition[], path: string): { page: HubbyPageDefinition, params: Record<string, string> } | null {
	const parts = path.split('/').filter(Boolean)
	for (const page of pages) {
		const pattern = page.path.split('/').filter(Boolean)
		if (pattern.length !== parts.length) continue
		const params: Record<string, string> = {}
		if (pattern.every((p, i) => p.startsWith(':') ? (params[p.slice(1)] = decodeURIComponent(parts[i]), true) : p === parts[i])) {
			return { page, params }
		}
	}
	return null
}

function Router({ definition }: { definition: HubbyDefinition }) {
	const path = usePath()
	const found = match(definition.pages, path)
	if (!found) return createElement('p', { className: 'p-6 text-sm text-steel-400' }, `Nothing at ${path}`)
	return createElement(found.page.component, { params: found.params })
}

/** Runs a hubby in its frame: announces its pages to the host, renders the one it is on. */
export function start(definition: HubbyDefinition): void {
	const pages: HubbyPage[] = definition.pages.map(p => ({ path: p.path, title: p.title, icon: p.icon, section: p.nav ? (p.nav.section ?? '') : undefined }))
	createRoot(document.getElementById('root')!).render(createElement(StrictMode, null, createElement(Router, { definition })))
	connect()
	register(pages, definition.navSections ?? {})
}
