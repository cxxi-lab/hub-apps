export const CONFIG = {
	DEBUG: import.meta.env.DEV,
	SERVER_URL_DEV: import.meta.env.VITE_SERVER_URL_DEV ?? 'https://localhost:8000',
	SERVER_URL_PROD: import.meta.env.VITE_SERVER_URL_PROD ?? 'https://x.cxxi.io',
}
