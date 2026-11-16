import type { TimelineDetailRenderer, TimelineItemsProvider } from './capabilities/timeline'

/** Planner's calendar: dated items in a range, and how to show one of them. */
export interface TimelineContribution {
	items: TimelineItemsProvider
	renderDetail?: TimelineDetailRenderer
}

/**
 * What a hubby can offer the others, by contribution point. A hubby consuming a point never
 * knows who contributes to it; a contribution lives only while its hubby is enabled and shown
 * (a private hubby's contributions disappear with it outside private mode). New points are added
 * here, as part of the SDK contract.
 */
export interface ContributionPoints {
	/** Planner's calendar: items dated by another hubby */
	timeline: TimelineContribution
}

export type ContributionPoint = keyof ContributionPoints

/** One hubby's contribution to a point. */
export interface Contribution<P extends ContributionPoint> {
	hubbyId: string
	/** @deprecated hubbyId: its SDK 2 name, still set for the hubbies built before the rename */
	moduleId: string
	value: ContributionPoints[P]
}
