import { useEffect, useState } from 'react'
import { onBackDepth, handleBack } from '@cxxi-lab/hub-ui'
import { PROTOCOL, type Envelope, type GuestMessage, type HostMessage, type HubbyPage } from '../protocol'

/**
 * The hubby SDK inside its frame (prototype): every call goes to the host by message and comes
 * back as a promise. The frame has no token, no cookie, no access to the app.
 */

let nextId = 1
const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>()
const initListeners = new Set<(init: Extract<HostMessage, { type: 'init' }>) => void>()
const pathListeners = new Set<(path: string) => void>()
let init: Extract<HostMessage, { type: 'init' }> | null = null

function post(message: GuestMessage) {
	const envelope: Envelope<GuestMessage> = { protocol: PROTOCOL, message }
	// the host's origin can't be checked from an opaque origin: '*', the host checks the source
	window.parent.postMessage(envelope, '*')
}

window.addEventListener('message', event => {
	if (event.source !== window.parent) return
	const data = event.data as Envelope<HostMessage> | undefined
	if (data?.protocol !== PROTOCOL) return
	const m = data.message
	if (m.type === 'result') {
		const p = pending.get(m.id)
		pending.delete(m.id)
		if (!p) return
		if (m.ok) p.resolve(m.value)
		else p.reject(new Error(m.error))
	}
	else if (m.type === 'init') {
		init = m
		initListeners.forEach(l => l(m))
	}
	else if (m.type === 'back') handleBack()
	else if (m.type === 'path') pathListeners.forEach(l => l(m.path))
})

/** A call to the host (the platform API, through it). */
export function call<T>(method: string, ...args: unknown[]): Promise<T> {
	const id = nextId++
	return new Promise<T>((resolve, reject) => {
		pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
		post({ type: 'call', id, method, args })
	})
}

export function useInit() {
	const [value, setValue] = useState(init)
	useEffect(() => {
		initListeners.add(setValue)
		setValue(init) // it may have come before this component listened
		return () => { initListeners.delete(setValue) }
	}, [])
	return value
}

export function usePath(): string {
	const [path, setPath] = useState(init?.path ?? '/')
	useEffect(() => {
		pathListeners.add(setPath)
		const onInit = (m: { path: string }) => setPath(m.path)
		initListeners.add(onInit)
		if (init) setPath(init.path)
		return () => { pathListeners.delete(setPath); initListeners.delete(onInit) }
	}, [])
	return path
}

export const nav = {
	navigate(path: string) {
		post({ type: 'navigate', path })
	}
}

export interface Doc { id: string, [field: string]: unknown }

/** A collection of the module (the generic API, through the host). */
export function collection(name: string) {
	return {
		find: () => call<Doc[]>('collection.find', name),
		create: (doc: Record<string, unknown>) => call<Doc>('collection.create', name, doc),
		remove: (id: string) => call<void>('collection.remove', name, id)
	}
}

export const settings = {
	/** a real API call made by the host (measures a network round trip) */
	account: () => call<Record<string, unknown>>('settings.account')
}

export const notifications = {
	upsert: (n: { key: string, title: string, body?: string }) => call<void>('notifications.upsert', n)
}

/** Announces the hubby's pages to its host (it builds the navigation). */
export function register(pages: HubbyPage[], sections: Record<string, unknown>) {
	post({ type: 'register', pages, sections })
}

/** Wires the frame to its host: ready, back depth, keys the app listens to (Ctrl+Alt…). */
export function connect() {
	onBackDepth(depth => post({ type: 'back-depth', depth }))
	window.addEventListener('keydown', e => {
		if (e.ctrlKey || e.altKey || e.metaKey) {
			post({ type: 'key', key: e.key, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey })
		}
	})
	post({ type: 'ready', at: performance.now() })
}
