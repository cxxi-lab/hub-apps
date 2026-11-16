/**
 * The messages between the app (host) and a hubby's frame (guest), both ways over postMessage.
 * (docs/plan-hubby-architecture.md § 4, 4 ter): the guest runs in a sandboxed iframe with an
 * opaque origin; it never gets a token, the host makes the API calls for it, within its scopes.
 */

/** A page of the hubby, as it announces it (its navigation is built by the host). */
export interface HubbyPage {
	/** relative to the hubby ('/', '/:id'…) */
	path: string
	title?: string
	/** a FontAwesome icon definition (plain data) */
	icon?: unknown
	/** in the navigation, under this section (no title: not in the navigation) */
	section?: string
}

/** Guest → host. */
export type GuestMessage =
	| { type: 'ready', at: number }
	| { type: 'register', pages: HubbyPage[], sections: Record<string, unknown> }
	| { type: 'call', id: number, method: string, args: unknown[] }
	| { type: 'back-depth', depth: number }
	| { type: 'key', key: string, ctrl: boolean, alt: boolean, shift: boolean, meta: boolean }
	| { type: 'navigate', path: string }

/** Host → guest. */
export type HostMessage =
	/**
	 * `theme`, `accent`: the app's (a host from before themes sends none: dark, blue). `module`: the
	 * hubby's id under its SDK 2 name, still sent for the hubbies built before the rename (a host from
	 * before it sends `module` only).
	 */
	| { type: 'init', hubby: string, module: string, path: string, phone: boolean, scopes: string[], theme?: 'light' | 'dark', accent?: string }
	| { type: 'result', id: number, ok: true, value: unknown }
	| { type: 'result', id: number, ok: false, error: string }
	| { type: 'back' }
	| { type: 'path', path: string }
	/** the app's theme or accent changed */
	| { type: 'theme', theme: 'light' | 'dark', accent?: string }

export const PROTOCOL = 'hubby/1'

export interface Envelope<M> {
	protocol: typeof PROTOCOL
	message: M
}
