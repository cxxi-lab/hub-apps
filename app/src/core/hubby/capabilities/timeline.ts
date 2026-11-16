import type { ReactNode } from 'react'

/**
 * Cross-hubby "timeline" capability. A hubby MAY expose dated items it owns (e.g.
 * workout sessions) that any calendar/agenda surface can display, plus an optional
 * self-contained detail view opened when an item is interacted with.
 *
 * Fully agnostic: no producer or consumer is named here. `payload` is opaque data the
 * PRODUCING hubby attaches and reads back in its own renderer — consumers never touch it.
 */
export interface TimelineItem {
	/** globally unique, namespaced by the source hubby, e.g. 'workout:123' */
	id: string
	date: Date
	title: string
	/** the hubby that produced it (for grouping / coloring) */
	hubbyId: string
	/** where a consumer can send the user for the full item (deep-link fallback) */
	href: string
	/** optional presentation hint: a CSS color used as the chip accent (generic) */
	color?: string
	/** opaque hubby-private data, read only by the producing hubby's renderDetail */
	payload?: unknown
}

/** Fetch a hubby's dated items overlapping [start, end). */
export type TimelineItemsProvider = (start: Date, end: Date) => Promise<TimelineItem[]>

export interface TimelineDetailContext {
	onClose: () => void
	/** call after a mutation so the consumer can refresh its data */
	onChanged: () => void
}

/** Render a self-contained detail view (e.g. a modal) for one of the hubby's items. */
export type TimelineDetailRenderer = (item: TimelineItem, ctx: TimelineDetailContext) => ReactNode
