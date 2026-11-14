import { useEffect, useSyncExternalStore } from 'react'
import { fetchSettings, updateSettings } from '@core/api/settings'

/**
 * Developer mode (the account's `account.developer` setting): the status bar and its console on
 * desktop, the console on a double tap of the logo on phones. Off by default. Shared by the
 * windows (Settings is one of its own on desktop) over a BroadcastChannel.
 */

const SCOPE = 'account'
const CHANNEL = 'hub-developer-mode'

let value = false
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: boolean) {
	if (next === value) return
	value = next
	listeners.forEach(l => l())
}

let channel: BroadcastChannel | null = null
try {
	channel = new BroadcastChannel(CHANNEL)
	channel.onmessage = e => set(e.data === true)
}
catch { /* no BroadcastChannel: each window reads it when it starts */ }

function load(): Promise<void> {
	loading ??= fetchSettings<{ developer?: boolean }>(SCOPE)
		.then(s => set(s.developer === true))
		.catch(err => {
			loading = null
			console.warn('[settings] developer mode not read', err)
		})
	return loading
}

export function useDeveloperMode(): boolean {
	useEffect(() => { void load() }, [])
	return useSyncExternalStore(
		l => { listeners.add(l); return () => listeners.delete(l) },
		() => value
	)
}

export async function setDeveloperMode(on: boolean): Promise<void> {
	const previous = value
	set(on)
	try {
		await updateSettings(SCOPE, { developer: on })
		channel?.postMessage(on)
	}
	catch (err) {
		set(previous)
		throw err
	}
}
