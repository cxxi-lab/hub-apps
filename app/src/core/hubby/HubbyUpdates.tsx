import { useEffect, useRef } from 'react'
import { platform } from '@platform'
import { HUBBY_MANIFESTS } from '@core/hubby/registry'
import { CHECK_NOW_MS, checkNow, runUpdates, UPDATE_CHECK_MS } from './updates'
import { onHubbiesEvent } from '@core/notifications/notifications'

/** Back after this long away (ms): a hubby running in the app gets its new version (the app reloads). */
const AWAY_MS = 2 * 60_000

/**
 * Hubbies update themselves (core/hubby/updates.ts): checked every minute, when the app comes back,
 * and when the open hubby changes (the one left gets its update then). Nothing to show here: the
 * update shows on the hubby's icon, its end in the notifications. A hubby still running in the app
 * gets its new version when the app comes back after a while (it reloads: nothing being typed is
 * cut off), else at the next start.
 */
export function HubbyUpdates({ activeHubby }: { activeHubby: string | null }) {
	const store = platform.hubbyStore
	const open = useRef(activeHubby)
	open.current = activeHubby
	const hiddenAt = useRef<number | null>(null)

	useEffect(() => { void runUpdates(activeHubby) }, [activeHubby])

	useEffect(() => {
		if (!store) return
		const timer = setInterval(() => void runUpdates(open.current), UPDATE_CHECK_MS)
		// a version just published (the server's real-time event): fetched now
		const offPublished = onHubbiesEvent(() => void checkNow(open.current))
		// asked from the tray: looked for again (the restricted ones too), every version ready applied, the open hubby's too
		const offApply = store.onApplyRequested?.(() => void checkNow(open.current, { includeOpen: true, report: true })) ?? (() => {})
		// and now and then on its own (the restricted hubbies' versions come only this way)
		const looking = setInterval(() => void checkNow(open.current), CHECK_NOW_MS)
		const hide = () => { hiddenAt.current ??= Date.now() }
		const show = () => {
			const away = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current
			hiddenAt.current = null
			void runUpdates(open.current)
			if (away < AWAY_MS) return
			// a hubby running in the app: its new version needs the app reloaded
			void store.pending().then(async pending => {
				const inApp = pending.some(p => !HUBBY_MANIFESTS.find(m => m.id === p.split(' ')[0])?.isolated)
				if (!inApp) return
				const activated = await store.activate()
				if (activated.length) window.location.reload()
			}).catch(() => { /* next time */ })
		}
		const onVisibility = () => (document.visibilityState === 'hidden' ? hide() : show())
		document.addEventListener('visibilitychange', onVisibility)
		// Capacitor (Android) also says so on the document
		document.addEventListener('pause', hide)
		document.addEventListener('resume', show)
		return () => {
			clearInterval(timer)
			clearInterval(looking)
			offPublished()
			offApply()
			document.removeEventListener('visibilitychange', onVisibility)
			document.removeEventListener('pause', hide)
			document.removeEventListener('resume', show)
		}
	}, [store])

	return null
}
