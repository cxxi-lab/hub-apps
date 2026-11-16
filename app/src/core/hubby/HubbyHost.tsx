import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { api } from '@core/api/client'
import { collection } from './collections'
import { hasScope, useHubbyScopes } from '@core/hubbies/scopes'
import { useBackHandler, useMediaQuery } from '@cxxi-lab/hubbyware-ui'
import { platform } from '@platform'
import { PROTOCOL, type Envelope, type GuestMessage, type HostMessage } from '@cxxi-lab/hubbyware-sdk/protocol'
import { setHubbyNav } from './navs'
import { currentAccent, currentTheme, useAccent, useTheme } from '@core/theme/theme'

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
	const src = platform.hubbyUrl(hubby)

	// the latest values the message handler reads (it is set up once)
	const state = useRef({ inner, phone, scopes })
	state.current = { inner, phone, scopes }

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

	useEffect(() => {
		const granted = (scope: string) => hasScope(state.current.scopes, hubby, scope)
		// its own collections, through the app's client: their encrypted fields sealed here, by the
		// host (the frame never sees the data key)
		const own = (name: unknown) => {
			if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(name)) throw new Error('invalid collection name')
			return collection<Record<string, unknown>>(hubby, name)
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
					send({ type: 'init', hubby, module: hubby, path: state.current.inner ?? '/', phone: state.current.phone, scopes: [], theme: currentTheme(), accent: currentAccent() })
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
						send({ type: 'result', id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) })
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
		return () => window.removeEventListener('message', onMessage)
	}, [hubby])

	if (!src) {
		return <div className="flex-1 flex items-center justify-center text-sm text-steel-400">This hubby runs isolated: not available on this platform yet.</div>
	}
	return (
		<iframe
			ref={frame}
			title={hubby}
			src={src}
			sandbox="allow-scripts allow-forms"
			className="flex-1 min-h-0 w-full border-0 bg-steel-900"
		/>
	)
}
