import { protocol } from 'electron'

/**
 * The app's own URL schemes, declared once before the app is ready (a second
 * registerSchemesAsPrivileged call replaces the first one's list).
 */
export const HUBBY_SCHEME = 'hubby'

protocol.registerSchemesAsPrivileged([
	// the isolated hubbies' frames (docs/plan-hubby-architecture.md § 4 ter): an origin of their
	// own; standard + secure for ES hubbies, CORS for their opaque origin
	{ scheme: HUBBY_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
