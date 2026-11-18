import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api, ApiError } from '@core/api/client'
import { getApiBaseUrl } from '@core/api/baseUrl'
import { collection } from './collections'
import { createOAuth } from './oauth'
import { hubbyApi } from './tokens'
import type { Task } from '@core/api/tasks'
import { hasScope, useHubbyScopes } from '@core/hubbies/scopes'
import { useBackHandler, useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import { platform } from '@platform'
import { PROTOCOL, type Envelope, type GuestMessage, type HostMessage } from '@cxxi-lab/hubbyware-sdk/protocol'
import { setHubbyNav } from './navs'
import { currentAccent, currentTheme, useAccent, useTheme } from '@core/theme/theme'
import { useAmountsBlurred, useBlurEpoch, useHubbyVisible, usePrivateMode } from '@core/privacy/hidden'
import { useVpnStatus } from '@shared/hooks/useVpnStatus'
import type { AppState, CallError, SurfaceState } from '@cxxi-lab/hubbyware-sdk/protocol'
import { storageSet, storageSnapshot } from './storage'
import { SurfaceViews, surfaceMethods, type WebviewElement } from './HubbySurfaces'

/**
 * What a frame learns of the shell (its URL: a manifest reads it as it loads). The companion's
 * engine isn't relayed to a frame (docs/plan-isolation.md D5): never said there.
 */
function frameCapabilities(): string {
	return Object.entries(platform.capabilities).filter(([name, on]) => on === true && name !== 'companion').map(([name]) => name).join(',')
}

/** The calls a frame may make to the server, as its hubby (the server checks what it declares). */
const API_PATHS = /^\/api\/cap\//

/** A request's options from a frame: a method, plain headers, a string body; nothing else. */
function requestOptions(options: unknown): RequestInit {
	const o = (options ?? {}) as { method?: unknown, headers?: unknown, body?: unknown }
	const headers = Object.fromEntries(Object.entries((o.headers ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
	return { method: typeof o.method === 'string' ? o.method : undefined, headers, body: typeof o.body === 'string' ? o.body : undefined }
}

function apiPath(path: unknown): string {
	if (typeof path !== 'string' || !API_PATHS.test(path)) throw new Error('a hubby calls its capabilities (/api/cap/…)')
	return path
}

/**
 * An isolated hubby (docs/plan-hubby-architecture.md § 4 ter): its frame — a sandboxed iframe
 * with an opaque origin, loaded from the platform's hubby address (desktop hubby://<id>/, Android
 * https://<id>.hubby.localhost/) — and the host side of its messages: its pages become the app's
 * navigation, its calls are made with the session, only within the scopes the account allowed it.
 */
export function HubbyHost({ hubby }: { hubby: string }) {
	const frame = useRef<HTMLIFrameElement>(null)
	const navigate = useNavigate()
	const { pathname } = useLocation()
	const phone = useMediaQuery('(width < 40rem)')
	const scopes = useHubbyScopes()
	const [backDepth, setBackDepth] = useState(0)
	const base = `/${hubby}`
	const inner = pathname === base ? '/' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null
	const base_ = platform.hubbyUrl(hubby)
	const src = base_ ? `${base_}?capabilities=${frameCapabilities()}` : null
	// its web surfaces (D3): the webviews shown over the frame
	const [surfaceStates, setSurfaceStates] = useState<Record<number, SurfaceState>>({})
	const surfaceElements = useRef(new Map<number, WebviewElement>()).current

	// the app's state, as the frame gets it (pushed at each change)
	const vpn = useVpnStatus()
	const appState: AppState = {
		phone,
		privateMode: usePrivateMode(),
		visible: useHubbyVisible(hubby),
		amountsBlurred: useAmountsBlurred(hubby),
		blurEpoch: useBlurEpoch(),
		tunnelReady: vpn.status === 'connected' && (vpn.hubby == null || vpn.hubby === hubby)
	}

	// the latest values the message handler reads (it is set up once)
	const state = useRef({ inner, phone, scopes, appState })
	state.current = { inner, phone, scopes, appState }

	const send = (message: HostMessage) => {
		const envelope: Envelope<HostMessage> = { protocol: PROTOCOL, message }
		// an opaque origin: '*' is the only target; the frame's window is the one it reaches
		frame.current?.contentWindow?.postMessage(envelope, '*')
	}

	useBackHandler(backDepth > 0, () => send({ type: 'back' }))
	useEffect(() => { if (inner !== null) send({ type: 'path', path: inner }) }, [inner])
	const theme = useTheme()
	const accent = useAccent()
	useEffect(() => { send({ type: 'theme', theme, accent }) }, [theme, accent])
	const stateKey = JSON.stringify(appState)
	useEffect(() => { send({ type: 'state', state: appState }) }, [stateKey])

	useEffect(() => {
		const granted = (scope: string) => hasScope(state.current.scopes, hubby, scope)
		// its own collections, through the app's client: their encrypted fields sealed here, by the
		// host (the frame never sees the data key)
		const own = (name: unknown) => {
			if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error('invalid collection name')
			return collection<Record<string, unknown>>(hubby, name)
		}
		// its connections at a provider: as the hubby (its token), the server checking what it declares
		const oauth = createOAuth((path, options) => hubbyApi(hubby).api(path, options))
		// its tasks (server docs/plan-tasks.md): its capabilities' calls, as the hubby (the server
		// checks what it declares); the host keeps the tasks the frame asked about, and pushes the
		// changes of those it follows
		const tasks = hubbyApi(hubby).tasks
		const held = new Map<string, Task>()
		// its server calls and streams, as the hubby
		const caller = hubbyApi(hubby)
		const streams = new Map<number, AbortController>()
		// the collections whose changes it follows
		const watching = new Map<string, () => void>()
		const docs = (name: unknown) => own(name) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		// the native player (Android): relayed, its events pushed once the frame listens
		const playerOffs: Array<() => void> = []
		const following = new Map<string, () => void>()
		const hold = (task: Task) => { held.set(task.id, task); return task.state }
		const heldTask = async (id: unknown): Promise<Task> => {
			if (typeof id !== 'string') throw new Error('invalid task id')
			const known = held.get(id)
			if (known) return known
			const task = await tasks.get(id)
			held.set(task.id, task)
			return task
		}
		// what a hubby may ask its host: its own collections and settings (no scope), the rest by scope
		const methods: Record<string, (...args: unknown[]) => unknown> = {
			'echo': (v: unknown) => v,
			'collection.find': async (name: unknown) => (await own(name).find({ limit: 200 })).data,
			'collection.create': (name: unknown, doc: unknown) => own(name).create((doc ?? {}) as Record<string, unknown>),
			'collection.remove': (name: unknown, id: unknown) => own(name).remove(encodeURIComponent(String(id))),
			'settings.account': () => {
				if (!granted('user:profile')) throw new Error('scope_denied: user:profile')
				return api<{ data?: unknown }>('/api/hub/settings/account').then(r => r.data)
			},
			'oauth.connections': () => oauth.connections(),
			'oauth.connect': (provider: unknown, options: unknown) => {
				const connection = (options as { connection?: unknown } | undefined)?.connection
				return oauth.connect(String(provider), { connection: typeof connection === 'string' ? connection : undefined })
			},
			'oauth.accessToken': (connection: unknown) => oauth.accessToken(String(connection)),
			'tasks.start': async (path: unknown, options: unknown) => {
				if (typeof path !== 'string' || !path.startsWith('/api/cap/')) throw new Error('a task is a capability\'s call (/api/cap/…)')
				const o = (options ?? {}) as { method?: unknown, body?: unknown, headers?: unknown }
				const headers = Object.fromEntries(Object.entries((o.headers ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
				return hold(await tasks.start(path, { method: typeof o.method === 'string' ? o.method : 'POST', body: typeof o.body === 'string' ? o.body : undefined, headers }))
			},
			'tasks.get': async (id: unknown) => (await heldTask(id)).state,
			'tasks.list': (status: unknown) => tasks.list(typeof status === 'string' ? status as never : undefined),
			'tasks.result': async (id: unknown) => (await heldTask(id)).result(),
			'tasks.cancel': async (id: unknown) => (await heldTask(id)).cancel(),
			'tasks.follow': async (id: unknown) => {
				const task = await heldTask(id)
				if (!following.has(task.id)) following.set(task.id, task.on(state => send({ type: 'task', task: state })))
				return null
			},
			'tasks.unfollow': (id: unknown) => {
				if (typeof id === 'string') { following.get(id)?.(); following.delete(id) }
				return null
			},
			'api': (path: unknown, options: unknown) => caller.api(apiPath(path), requestOptions(options)),
			'stream.open': (id: unknown, path: unknown, options: unknown) => {
				if (typeof id !== 'number') throw new Error('invalid stream id')
				const controller = new AbortController()
				streams.set(id, controller)
				return caller.apiStream(apiPath(path), { ...requestOptions(options), signal: controller.signal }, (event, data) => send({ type: 'stream', stream: id, event, data }))
					.finally(() => streams.delete(id))
			},
			'stream.abort': (id: unknown) => {
				if (typeof id === 'number') streams.get(id)?.abort()
				return null
			},
			// its collections, whole (docs/plan-isolation.md § 2)
			...Object.fromEntries(['find', 'findAll', 'get', 'create', 'createWithId', 'update', 'replace', 'remove', 'batch'].map(m => [
				`collections.${m}`, (name: unknown, ...args: unknown[]) => docs(name)[m](...args)
			])),
			'collection.watch': (name: unknown) => {
				const key = String(name)
				if (!watching.has(key)) watching.set(key, own(name).onChange(doc => send({ type: 'changed', collection: key, doc })))
				return null
			},
			'collection.unwatch': (name: unknown) => {
				watching.get(String(name))?.()
				watching.delete(String(name))
				return null
			},
			// its own storage on this device (its frame has none)
			'storage.set': (key: unknown, value: unknown) => { storageSet(hubby, String(key), value === null ? null : String(value)); return null },
			// the native player (Android, capabilities.nativePlayer)
			...(platform.capabilities.nativePlayer ? {
				'player.open': (options: unknown) => platform.player.open(options as Parameters<typeof platform.player.open>[0]),
				'player.exec': (script: unknown) => platform.player.exec(String(script)),
				'player.reload': () => platform.player.reload(),
				'player.close': () => platform.player.close(),
				'player.setActions': (actions: unknown, icons: unknown) => platform.player.setActions(actions as never, icons as never),
				'player.showPanel': (panel: unknown) => platform.player.showPanel(panel as never),
				'player.listen': () => {
					if (playerOffs.length) return null
					playerOffs.push(
						platform.player.onReady(() => send({ type: 'player', event: 'ready' })),
						platform.player.onClosed(() => send({ type: 'player', event: 'closed' })),
						platform.player.onAction(id => send({ type: 'player', event: 'action', value: id })),
						platform.player.onNavigate(direction => send({ type: 'player', event: 'navigate', value: direction }))
					)
					return null
				}
			} : {}),
			// its web surfaces (desktop: capabilities.webview)
			...surfaceMethods((id, next) => setSurfaceStates(prev => {
				const copy = { ...prev }
				if (next) copy[id] = next
				else delete copy[id]
				return copy
			}), surfaceElements, (path, options) => caller.api(path, options)),
			'notifications.upsert': () => {
				if (!granted('app:notifications')) throw new Error('scope_denied: app:notifications')
				return null
			}
		}

		const onMessage = async (event: MessageEvent) => {
			// only this frame's messages (an opaque origin can't be checked: its window can)
			if (!frame.current || event.source !== frame.current.contentWindow) return
			const data = event.data as Envelope<GuestMessage> | undefined
			if (data?.protocol !== PROTOCOL) return
			const m = data.message
			switch (m.type) {
				case 'ready':
					send({ type: 'init', hubby, path: state.current.inner ?? '/', phone: state.current.phone, scopes: [], theme: currentTheme(), accent: currentAccent(), apiBase: getApiBaseUrl(), storage: storageSnapshot(hubby) })
					send({ type: 'state', state: state.current.appState })
					break
				case 'register':
					setHubbyNav(hubby, m.pages, m.sections)
					break
				case 'call': {
					const method = methods[m.method]
					try {
						if (!method) throw new Error(`unknown method ${m.method}`)
						send({ type: 'result', id: m.id, ok: true, value: await method(...m.args) })
					}
					catch (err) {
						const failure: CallError = err instanceof ApiError
							? { message: err.message, status: err.status, detail: err.detail }
							: { message: err instanceof Error ? err.message : String(err) }
						send({ type: 'result', id: m.id, ok: false, error: failure.message, failure })
					}
					break
				}
				case 'back-depth':
					setBackDepth(m.depth)
					break
				case 'navigate':
					navigate(`${base}${m.path === '/' ? '' : m.path}`)
					break
				case 'key':
					// the app's shortcuts (Ctrl+Alt reveal…) don't see keys typed in the frame: replayed here
					window.dispatchEvent(new KeyboardEvent('keydown', { key: m.key, ctrlKey: m.ctrl, altKey: m.alt, shiftKey: m.shift, metaKey: m.meta }))
					break
			}
		}
		window.addEventListener('message', onMessage)
		return () => {
			window.removeEventListener('message', onMessage)
			following.forEach(stop => stop())
			following.clear()
			streams.forEach(controller => controller.abort())
			streams.clear()
			watching.forEach(stop => stop())
			watching.clear()
			playerOffs.forEach(stop => stop())
			setSurfaceStates({})
		}
	}, [hubby])

	if (!src) {
		return <div className="flex-1 flex items-center justify-center text-sm text-steel-400">This hubby runs isolated: not available on this platform yet.</div>
	}
	return (
		<div className="relative flex-1 min-h-0 flex">
			<iframe
				ref={frame}
				title={hubby}
				src={src}
				// popups: its links open outside the app (the system's browser, the shell decides), as a
				// mail's links and attachments do
				sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
				className="flex-1 min-h-0 w-full border-0 bg-steel-900"
			/>
			{platform.capabilities.webview && (
				<SurfaceViews hubby={hubby} surfaces={{ states: surfaceStates, elements: surfaceElements }} call={(path, options) => hubbyApi(hubby).api(path, options)} send={send} />
			)}
		</div>
	)
}
