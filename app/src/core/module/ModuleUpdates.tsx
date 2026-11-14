import { useEffect, useRef, useState } from 'react'
import { faRotate, faXmark } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { platform } from '@platform'
import { MODULE_MANIFESTS } from '@core/module/registry'

/** Back after this long away (ms): the new versions are switched to without asking. */
const AWAY_MS = 2 * 60_000
const CHECK_EVERY_MS = 60_000

/**
 * Module versions are decided at start (never a half-updated session); a newer one downloaded in
 * the background used to wait for the next start, while the server may already have moved on
 * (e.g. an API retired). Here: a bar offers to reload as soon as one is ready, and coming back to
 * the app after a while reloads by itself (nothing being typed is cut off).
 */
export function ModuleUpdates() {
	const store = platform.moduleStore
	const [pending, setPending] = useState<string[]>([])
	const [dismissed, setDismissed] = useState<string>('')
	const hiddenAt = useRef<number | null>(null)

	const apply = async () => {
		try {
			const activated = await store!.activate()
			if (activated.length) {
				console.info('[modules] switching to', activated.join(', '))
				window.location.reload()
			}
		}
		catch (err) {
			console.warn('[modules] not switched', err)
		}
	}

	useEffect(() => {
		if (!store) return
		const check = () => store.pending().then(setPending).catch(() => { /* next time */ })
		void check()
		const timer = setInterval(check, CHECK_EVERY_MS)

		const hide = () => { hiddenAt.current ??= Date.now() }
		const show = () => {
			const away = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current
			hiddenAt.current = null
			void store.pending().then(next => {
				setPending(next)
				if (next.length && away >= AWAY_MS) void apply()
			}).catch(() => { /* next time */ })
		}
		const onVisibility = () => (document.visibilityState === 'hidden' ? hide() : show())
		document.addEventListener('visibilitychange', onVisibility)
		// Capacitor (Android) also says so on the document
		document.addEventListener('pause', hide)
		document.addEventListener('resume', show)
		return () => {
			clearInterval(timer)
			document.removeEventListener('visibilitychange', onVisibility)
			document.removeEventListener('pause', hide)
			document.removeEventListener('resume', show)
		}
	}, [store])

	const key = pending.join(',')
	if (!store || !pending.length || dismissed === key) return null

	const names = pending.map(p => {
		const [id, version] = p.split(' ')
		return `${MODULE_MANIFESTS.find(m => m.id === id)?.label ?? id} ${version}`
	})

	return (
		<div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-steel-900 border-b border-steel-700 text-xs text-steel-300">
			<FontAwesomeIcon icon={faRotate} className="text-primary-500" />
			<span className="flex-1 min-w-0 truncate">Updates ready: {names.join(', ')}</span>
			<button
				type="button"
				onClick={() => void apply()}
				className="shrink-0 h-7 px-3 rounded bg-primary-500 hover:bg-primary-300 text-steel-950 font-semibold border-0 cursor-pointer"
			>
				Reload
			</button>
			<button
				type="button"
				onClick={() => setDismissed(key)}
				title="Later (at the next start)"
				aria-label="Later"
				className="shrink-0 size-7 flex items-center justify-center rounded bg-transparent border-0 text-steel-400 hover:text-white cursor-pointer"
			>
				<FontAwesomeIcon icon={faXmark} />
			</button>
		</div>
	)
}
