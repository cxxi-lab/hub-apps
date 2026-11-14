import type { TimelineDetailRenderer, TimelineItemsProvider } from './capabilities/timeline'

/** Planner's calendar: dated items in a range, and how to show one of them. */
export interface TimelineContribution {
	items: TimelineItemsProvider
	renderDetail?: TimelineDetailRenderer
}

/**
 * What a module can offer the others, by contribution point. A module consuming a point never
 * knows who contributes to it; a contribution lives only while its module is enabled and shown
 * (a private module's contributions disappear with it outside private mode). New points are added
 * here, as part of the SDK contract.
 */
export interface ContributionPoints {
	/** Planner's calendar: items dated by another module */
	timeline: TimelineContribution
}

export type ContributionPoint = keyof ContributionPoints

/** One module's contribution to a point. */
export interface Contribution<P extends ContributionPoint> {
	moduleId: string
	value: ContributionPoints[P]
}
