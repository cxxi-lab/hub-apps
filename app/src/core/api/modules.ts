import { api } from './client'

export interface ModulesState {
	/** Module slugs the server can actually serve (registered ModuleInterface implementations). */
	available: string[]
	/**
	 * The user's enabled module slugs, in their top-bar order. null = all modules enabled, in the
	 * catalogue order (opt-out default).
	 */
	enabled: string[] | null
	/** The enabled modules also shown in the top bar (in the enabled order). */
	pinned: string[]
	/** The modules hidden behind a reveal shortcut (Privacy); absent: not read yet. */
	hidden?: string[]
	/** The modules locked by a password of their own (Privacy): their pages wait for it. */
	locked?: string[]
	/** The modules whose amounts are blurred (Privacy). */
	blurred?: string[]
}

export function fetchModulesState() {
	return api<{ data: ModulesState }>('/api/hub/modules').then(r => r.data)
}

export function setEnabledModules(enabled: string[] | null) {
	return api<{ data: ModulesState }>('/api/hub/modules', {
		method: 'PATCH',
		body: JSON.stringify({ enabled })
	}).then(r => r.data)
}

export function setPinnedModules(pinned: string[]) {
	return api<{ data: ModulesState }>('/api/hub/modules', {
		method: 'PATCH',
		body: JSON.stringify({ pinned })
	}).then(r => r.data)
}

/** Both lists at once (adding a module enables and pins it). */
export function updateModules(patch: { enabled?: string[] | null, pinned?: string[] }) {
	return api<{ data: ModulesState }>('/api/hub/modules', {
		method: 'PATCH',
		body: JSON.stringify(patch)
	}).then(r => r.data)
}

// A change of the modules (the Modules screen, a pin on the home page) is announced to the app's
// windows and pages (same origin): each one follows.
const CHANNEL = 'hub:modules'

export function announceModulesChange(state: ModulesState) {
	try {
		const channel = new BroadcastChannel(CHANNEL)
		channel.postMessage(state)
		channel.close()
	}
	catch { /* no BroadcastChannel: the main window refetches when focused */ }
}

export function onModulesChange(cb: (state: ModulesState) => void): () => void {
	try {
		const channel = new BroadcastChannel(CHANNEL)
		channel.onmessage = e => cb(e.data as ModulesState)
		return () => channel.close()
	}
	catch {
		return () => {}
	}
}
