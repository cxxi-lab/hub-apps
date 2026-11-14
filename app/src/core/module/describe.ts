import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { ModulePackage } from '@platform'
import type { ModuleManifest, StorageScope } from './types'

/**
 * A module's module.json: its version, the SDK it needs, and how it is described before it is
 * installed (the store lists modules from these, see scripts/build-modules.mjs). `icon` is a Font
 * Awesome solid icon name, the one its manifest shows.
 */
export interface ModuleInfo {
	version: string
	sdk: string
	label: string
	description?: string
	icon?: string
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
	/** shared features (ModuleSupport) */
	supports?: string[]
	/** the scopes of its data the account places (local or server) */
	storage?: { scopes: StorageScope[] }
}

type Described = Pick<ModuleManifest, 'label' | 'description' | 'local' | 'requires' | 'requiresCapabilities' | 'supports' | 'storage'>

/** The manifest's descriptive part, from its module.json (one source for both). */
export function describe(info: ModuleInfo): Described {
	return {
		label: info.label,
		description: info.description,
		local: info.local,
		requires: info.requires,
		requiresCapabilities: info.requiresCapabilities as Described['requiresCapabilities'],
		supports: info.supports as Described['supports'],
		storage: info.storage
	}
}

/** A catalogue entry's icon, as Font Awesome draws it. */
export function entryIcon(entry: ModulePackage): IconDefinition | undefined {
	if (!entry.icon) return undefined
	const [width, height, path] = entry.icon
	return { prefix: 'fas', iconName: `hub-${entry.id}` as IconDefinition['iconName'], icon: [width, height, [], '', path] }
}
