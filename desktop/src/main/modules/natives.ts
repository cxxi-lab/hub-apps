/**
 * Where the installed modules' native files are (e.g. Private's wireproxy), without importing the
 * module manager: the VPN needs it, and the manager depends (through the updater) on the VPN. The
 * manager registers its lookup at setup; before that, or in a build running the modules from their
 * sources, there is none.
 */
let lookup: ((name: string) => string | null) | null = null

export function registerNativeLookup(find: (name: string) => string | null): void {
	lookup = find
}

/** A native file of whichever installed module brings it (this platform's), or null. */
export function findNative(name: string): string | null {
	return lookup?.(name) ?? null
}
