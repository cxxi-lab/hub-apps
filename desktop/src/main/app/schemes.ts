import { protocol } from 'electron'

/**
 * The app's own URL schemes, declared once before the app is ready (a second
 * registerSchemesAsPrivileged call replaces the first one's list).
 */
export const MEDIA_SCHEME = 'companion-media'
export const HUBBY_SCHEME = 'hubby'

protocol.registerSchemesAsPrivileged([
	// voice messages and photos, served to the app window from the local media dir
	{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
	// the isolated hubbies' frames (docs/plan-module-architecture.md § 4 ter): an origin of their
	// own; standard + secure for ES modules, CORS for their opaque origin
	{ scheme: HUBBY_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
])
