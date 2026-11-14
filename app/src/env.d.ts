/// <reference types="vite/client" />
/// <reference types="vite-plugin-svgr/client" />

import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
	interface Window {
		hubBack?: () => boolean
	}

	namespace JSX {
		interface IntrinsicElements {
			webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
				src?: string
				partition?: string
				allowpopups?: string
				useragent?: string
				webpreferences?: string
			}
		}
	}
}

interface ImportMetaEnv {
	readonly VITE_SERVER_URL_DEV?: string
	readonly VITE_SERVER_URL_PROD?: string
	readonly VITE_SERVER_URL_PRIVATE?: string
}

interface ImportMeta {
	readonly env: ImportMetaEnv
}

export {}
