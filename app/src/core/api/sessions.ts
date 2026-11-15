import { api } from './client'

/** A signed-in device (a session of the account): what the server last saw of it. */
export interface DeviceSession {
	id: string
	/** 'desktop', 'android'; null: not seen since devices were tracked */
	client: string | null
	ip: string | null
	userAgent: string | null
	createdAt: string | null
	lastUsedAt: string | null
	expiresAt: string | null
	/** this device */
	current: boolean
}

export function fetchSessions() {
	return api<{ data: DeviceSession[] }>('/api/hub/sessions').then(r => r.data)
}

/** Signs a device out: its access stops at once. */
export function revokeSession(id: string) {
	return api<{ ok: true }>(`/api/hub/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
