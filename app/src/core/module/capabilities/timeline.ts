import type { ReactNode } from 'react'

/**
 * Cross-module "timeline" capability. A module MAY expose dated items it owns (e.g.
 * workout sessions) that any calendar/agenda surface can display, plus an optional
 * self-contained detail view opened when an item is interacted with.
 *
 * Fully agnostic: no producer or consumer is named here. `payload` is opaque data the
 * PRODUCING module attaches and reads back in its own renderer — consumers never touch it.
 */
export interface TimelineItem {
	/** globally unique, namespaced by the source module, e.g. 'workout:123' */
	id: string
	date: Date
	title: string
	/** the module that produced it (for grouping / coloring) */
	moduleId: string
	/** where a consumer can send the user for the full item (deep-link fallback) */
	href: string
	/** optional presentation hint: a CSS color used as the chip accent (generic) */
	color?: string
	/** opaque module-private data, read only by the producing module's renderDetail */
	payload?: unknown
}

/** Fetch a module's dated items overlapping [start, end). */
export type TimelineItemsProvider = (start: Date, end: Date) => Promise<TimelineItem[]>

export interface TimelineDetailContext {
	onClose: () => void
	/** call after a mutation so the consumer can refresh its data */
	onChanged: () => void
}

/** Render a self-contained detail view (e.g. a modal) for one of the module's items. */
export type TimelineDetailRenderer = (item: TimelineItem, ctx: TimelineDetailContext) => ReactNode
