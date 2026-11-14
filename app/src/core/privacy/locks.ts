import { useSyncExternalStore } from 'react'
import { moduleOfCapability } from '@core/module/declarations'

/**
 * The locked modules (Privacy: a password of their own). Their API answers 423 until the app sends
 * an unlock token (X-Hub-Unlock), given by the server against that password. The tokens live here,
 * in memory: forgotten on leaving the module, after a while without activity in it, when they run
 * out, and whenever the server says the module is locked (a 423).
 */

export const UNLOCK_HEADER = 'X-Hub-Unlock'

const tokens = new Map<string, { token: string, expires: number }>()
const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
	revision++
	for (const cb of listeners) cb()
}

/**
 * The module an API path belongs to, null for the service's (/api/hub/…): its data
 * (/api/data/<module>/…), or a capability only it uses (/api/cap/<capability>/…, as it declares).
 */
export function moduleOfPath(path: string): string | null {
	const data = /^\/api\/data\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	if (data) return data[1]
	const capability = /^\/api\/cap\/([a-z0-9-]+)(?:[/?]|$)/.exec(path)
	return capability ? moduleOfCapability(capability[1]) : null
}

/** The headers unlocking the module a call goes to, if it is unlocked here. */
export function unlockHeaders(path: string): Record<string, string> {
	const module = moduleOfPath(path)
	const unlocked = module ? tokens.get(module) : undefined
	if (!unlocked) return {}
	if (unlocked.expires <= Date.now()) {
		lock(module!)
		return {}
	}
	return { [UNLOCK_HEADER]: unlocked.token }
}

/** A 423: the module is locked (again) for the server. */
export function lockedByServer(path: string): void {
	const module = moduleOfPath(path)
	if (module && tokens.has(module)) lock(module)
}

export function isUnlocked(module: string): boolean {
	const unlocked = tokens.get(module)
	return !!unlocked && unlocked.expires > Date.now()
}

export function setUnlocked(module: string, token: string, expiresIn: number): void {
	tokens.set(module, { token, expires: Date.now() + expiresIn * 1000 - 5000 })
	changed()
}

export function lock(module: string): void {
	if (tokens.delete(module)) changed()
}

/** Re-renders when a module is unlocked or locked again. */
export function useLocks(): number {
	return useSyncExternalStore(cb => { listeners.add(cb); return () => { listeners.delete(cb) } }, () => revision)
}
