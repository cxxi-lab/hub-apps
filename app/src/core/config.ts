export const CONFIG = {
	DEBUG: import.meta.env.DEV,
	SERVER_URL_DEV: import.meta.env.VITE_SERVER_URL_DEV ?? 'https://localhost:8000',
	SERVER_URL_PROD: import.meta.env.VITE_SERVER_URL_PROD ?? 'https://x.cxxi.io',
	/** the same server under the name only reachable through the VPN: Private's API and media (prod) */
	SERVER_URL_PRIVATE_PROD: import.meta.env.VITE_SERVER_URL_PRIVATE ?? 'https://vpn.cxxi.io',
}
