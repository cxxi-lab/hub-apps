import type { ComponentType, ReactNode } from 'react'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { PlatformCapabilities } from '@platform'
import type { ContributionPoints } from './contributions'

export interface ModuleNavItem {
	to: string
	label: string
	/** optional live label (e.g. a name read at runtime + a badge), rendered instead of `label` */
	Label?: ComponentType
	/** the block of the sidebar it sits in, under this title (consecutive items share it) */
	section?: string
	/** its icon in the phone's bottom bar (default: its section's, then the module's) */
	icon?: IconDefinition
	/** the page the module opens on (default: the first item) */
	home?: boolean
}

export interface ModuleWindow {
	/** unique in the module ([a-z0-9-]) */
	id: string
	title: string
	Component: ComponentType
	width?: number
	height?: number
	/** an entry of the app menu (Window) opening it */
	menu?: { label: string, accelerator?: string }
}

export interface ModuleRoute {
	path: string
	Component: ComponentType
	/** kept mounted (KeepAlive) so page state survives navigation */
	persistent?: boolean
	/** also answers the paths under it (an isolated hubby: /<id>/… all go to its frame) */
	prefix?: boolean
}

/**
 * Desktop-side module manifest. The desktop owns the module catalogue (which modules
 * exist, their nav and pages); the server advertises which it can serve + which the
 * user enabled. `id` must match the server module slug (singular, e.g. 'workout').
 */
/**
 * A shared feature a module may support:
 *  - 'notifications': its notifications (the top bar's dot, the bell, its settings section);
 *  - 'vpn': the VPN tunnel, run only while the module is open (its pages wait for it);
 *  - 'amounts': it shows amounts (money…): its Privacy can blur them (the SDK's Amount).
 */
export type ModuleSupport = 'notifications' | 'vpn' | 'amounts'

export interface ModuleManifest {
	id: string
	label: string
	/** its card on the home page */
	icon?: IconDefinition
	/** one line under its name on the home page */
	description?: string
	/** its own part of its settings screen (Modules > the module), under the common one */
	Settings?: ComponentType
	/**
	 * Runs entirely on this machine with no server counterpart: always shown, outside the
	 * server's enabled list and the front/server integrity diff.
	 */
	local?: boolean
	/**
	 * Host capabilities this module needs (see PlatformCapabilities). A shell that
	 * lacks any of them hides the module entirely — e.g. 'companion' and 'webview'
	 * are desktop-only, so AI never appears in the mobile shell.
	 */
	requiresCapabilities?: Array<keyof PlatformCapabilities>
	navItems: ModuleNavItem[]
	/**
	 * Runs isolated, in a sandboxed frame (docs/plan-module-architecture.md § 4 ter): none of its
	 * code is loaded in the app; its navigation is the one its frame announces.
	 */
	isolated?: boolean
	/** the icons of its nav sections (by title): a section is a tab of the phone's bottom bar */
	navSections?: Record<string, IconDefinition>
	routes: ModuleRoute[]
	/**
	 * Modules this one cannot work without (ids): it is only active while they all are, and
	 * the Modules screen says so. For a feature that only makes sense with another module, prefer
	 * a contribution of that module (`contributes`).
	 */
	requires?: string[]
	/**
	 * The shared features it supports (as its server module does): each brings its part of the
	 * module's settings and its plumbing in the app, e.g. 'notifications' (the top bar's badge).
	 */
	supports?: ModuleSupport[]
	/** What this module offers the others, by contribution point (see ContributionPoints). */
	contributes?: Partial<ContributionPoints>
	/**
	 * Contexts this module needs around the whole app while it is active (e.g. a job followed from
	 * any page), outermost first.
	 */
	providers?: Array<ComponentType<{ children: ReactNode }>>
	/** Windows of its own (desktop only), opened with platform.openModuleWindow(moduleId, id). */
	windows?: ModuleWindow[]
}
