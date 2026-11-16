import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import type { HubbyPackage } from '@platform'
import type { HubbyManifest } from './types'

/**
 * A hubby's hubby.json: its version, the SDK it needs, and how it is described before it is
 * installed (the store lists hubbies from these, see scripts/build-hubbies.mjs). `icon` is a Font
 * Awesome solid icon name, the one its manifest shows.
 */
export interface HubbyInfo {
	version: string
	sdk: string
	label: string
	description?: string
	icon?: string
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
	/** shared features (HubbySupport) */
	supports?: string[]
}

type Described = Pick<HubbyManifest, 'label' | 'description' | 'local' | 'requires' | 'requiresCapabilities' | 'supports'>

/** The manifest's descriptive part, from its hubby.json (one source for both). */
export function describe(info: HubbyInfo): Described {
	return {
		label: info.label,
		description: info.description,
		local: info.local,
		requires: info.requires,
		requiresCapabilities: info.requiresCapabilities as Described['requiresCapabilities'],
		supports: info.supports as Described['supports']
	}
}

/** A catalogue entry's icon, as Font Awesome draws it. */
export function entryIcon(entry: HubbyPackage): IconDefinition | undefined {
	if (!entry.icon) return undefined
	const [width, height, path] = entry.icon
	return { prefix: 'fas', iconName: `hub-${entry.id}` as IconDefinition['iconName'], icon: [width, height, [], '', path] }
}
