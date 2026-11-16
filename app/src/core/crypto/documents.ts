/**
 * The modules' models (docs/spec-module.md § 5): what each collection holds, as the module ships it
 * (models.json, downloaded with it and checked against its signed catalogue entry, or its sources'
 * models/ in development). The local-first collections check documents against them
 * (core/sync/validate.ts) and follow their defaults, unique indexes and references.
 */

export interface FieldSpec {
	type: string
	/** true / 'equality' / 'server': a field once sealed on its way to the server; the data now stays sealed whole (core/sync) */
	encrypted?: boolean | 'equality' | 'server'
	required?: boolean
	default?: unknown
	/** a `ref`: the collection it points to, and what its deletion does */
	collection?: string
	onDelete?: 'nullify' | 'cascade' | 'restrict'
	fields?: Record<string, FieldSpec>
	items?: FieldSpec
}

export interface ModelFile {
	collection: string
	version: number
	fields: Record<string, FieldSpec>
	indexes?: Array<{ fields: Array<[string, number]>, unique?: boolean }>
}

const MODELS = new Map<string, Map<string, ModelFile>>()

/** A module's models as registered (by collection). */
export const modelsOf = (module: string): Map<string, ModelFile> => MODELS.get(module) ?? new Map()

/** A module's models (as it ships them: models.json, by collection), registered as it loads. */
export function registerModels(module: string, models: Record<string, ModelFile> | ModelFile[]): void {
	for (const model of Object.values(models)) {
		if (!MODELS.has(module)) MODELS.set(module, new Map())
		MODELS.get(module)!.set(model.collection, model)
	}
}

export class DataKeyMissingError extends Error {
	constructor() {
		super('This device has no data key yet: link it to one of your devices in Settings → Security')
		this.name = 'DataKeyMissingError'
	}
}
