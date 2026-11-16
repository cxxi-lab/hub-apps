import { localCollection } from '@core/sync/localCollection'

/**
 * A module's declared collection (docs/spec-module.md § 5): the current account's documents, kept
 * on this device and synced through the server, which only relays them sealed
 * (docs/plan-local-first.md, core/sync). For the modules running in the app; an isolated hubby gets
 * the same through its host (@cxxi-lab/hub-sdk/frame, packages/hub-sdk/frame/sdk.ts).
 */

/** What the platform adds to every document. */
export interface HubbyDocument {
	id: string
	_createdAt: string
	_updatedAt: string
	_version: number
}

/** A filter's value: equality, or operators (`in` takes a list). Fields: indexed ones only. */
export type FilterValue = string | number | boolean | null
	| { eq?: FilterValue, ne?: FilterValue, in?: FilterValue[], gt?: FilterValue, gte?: FilterValue, lt?: FilterValue, lte?: FilterValue, exists?: boolean, prefix?: string }

export interface CollectionQuery {
	filter?: Record<string, FilterValue>
	/** fields along an index, `-` for descending (e.g. '-_updatedAt'); default '-_updatedAt' */
	sort?: string
	/** 1–200, default 50 */
	limit?: number
	cursor?: string
}

export interface CollectionPage<T> {
	data: T[]
	next: string | null
}

export type BatchOperation<T> =
	| { op: 'create', data: Partial<T> }
	| { op: 'update', id: string, data: Partial<T>, version?: number }
	| { op: 'delete', id: string }

/** One of a module's collections. `T`: its declared fields (the platform's are added). */
export function collection<T extends object>(module: string, name: string) {
	return localCollection<T>(module, name)
}
