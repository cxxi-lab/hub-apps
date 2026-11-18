import { call, currentInit, onHostMessage } from './sdk'
import type { CompanionApi, NativePlayerAction, NativeIcon, NativePlayerApi, NativePlayerOptions, NativePlayerPanel } from './types'

/**
 * The shell, as a hubby's frame sees it (docs/plan-isolation.md, phase 4): its capabilities (in the
 * frame's URL, set by the host: a manifest reads them as it loads) and the native player (Android),
 * relayed by the host. Nothing else of the app's `platform` (its secrets, its windows) reaches a frame.
 */

function readCapabilities(): Record<string, boolean> {
	try {
		const list = new URLSearchParams(window.location.search).get('capabilities') ?? ''
		return Object.fromEntries(list.split(',').filter(Boolean).map(name => [name, true]))
	}
	catch {
		return {}
	}
}

type Listener<T> = (value: T) => void
const listeners = { ready: new Set<Listener<void>>(), closed: new Set<Listener<void>>(), action: new Set<Listener<string>>(), navigate: new Set<Listener<'prev' | 'next'>>() }
let listening = false

onHostMessage(m => {
	if (m.type !== 'player') return
	if (m.event === 'action') listeners.action.forEach(l => l(m.value ?? ''))
	else if (m.event === 'navigate') listeners.navigate.forEach(l => l(m.value === 'prev' ? 'prev' : 'next'))
	else listeners[m.event].forEach(l => l())
})

function on<T>(set: Set<Listener<T>>, cb: Listener<T>): () => void {
	if (!listening) {
		listening = true
		void call('player.listen')
	}
	set.add(cb)
	return () => { set.delete(cb) }
}

/** The fullscreen native player (Android, `capabilities.nativePlayer`), through the host. */
const player: NativePlayerApi = {
	open: (options: NativePlayerOptions) => call<void>('player.open', options),
	exec: (script: string) => call<void>('player.exec', script),
	reload: () => call<void>('player.reload'),
	close: () => call<void>('player.close'),
	setActions: (actions: NativePlayerAction[], icons: { menu: NativeIcon, close: NativeIcon }) => call<void>('player.setActions', actions, icons),
	showPanel: (panel: NativePlayerPanel | null) => call<void>('player.showPanel', panel),
	onReady: (cb: () => void) => on(listeners.ready, cb),
	onClosed: (cb: () => void) => on(listeners.closed, cb),
	onAction: (cb: (id: string) => void) => on(listeners.action, cb),
	onNavigate: (cb: (direction: 'prev' | 'next') => void) => on(listeners.navigate, cb)
}

/** What the shell can do here (the frame's URL: set by the host). */
export interface Capabilities {
	webview?: boolean
	nativePlayer?: boolean
	vpn?: boolean
	vpnPerWebview?: boolean
	/** never in a frame (docs/plan-isolation.md D5) */
	companion?: boolean
	[name: string]: boolean | undefined
}

export interface FramePlatform {
	name: 'frame'
	capabilities: Capabilities
	player: NativePlayerApi
	/**
	 * Not in a frame (D5: the companion waits for the AI chantier): undefined. Typed for the code
	 * kept until then, reached only behind `capabilities.companion`, never true here.
	 */
	companion: CompanionApi
}

export const platform: FramePlatform = {
	name: 'frame',
	capabilities: readCapabilities(),
	player,
	companion: undefined as unknown as CompanionApi
}

// --- the hubby's own storage ---

let values: Map<string, string> | null = null
const stored = () => (values ??= new Map(Object.entries(currentInit()?.storage ?? {})))

/**
 * The hubby's own key-value storage on this device (what it kept in localStorage: a frame has
 * none): read at once from the snapshot the host gave at start, written through the host.
 */
export const storage = {
	getItem: (key: string): string | null => stored().get(key) ?? null,
	setItem(key: string, value: string): void {
		stored().set(key, String(value))
		void call('storage.set', key, String(value))
	},
	removeItem(key: string): void {
		stored().delete(key)
		void call('storage.set', key, null)
	}
}
