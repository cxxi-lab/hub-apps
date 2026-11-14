import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { platform } from '@platform'
import { useModules } from '@core/contexts/ModulesContext'
import { useNotifications } from '@core/notifications/notifications'
import { registerPushDevice } from '@core/notifications/push'

/**
 * The notifications shown by the system, and a click there opens where one leads. Desktop: the app
 * hands its list over (bubbles, a dot on the tray icon). Android: the server pushes them (even with
 * the app closed): this device registers for them. Renders nothing.
 */
export function SystemNotifications() {
	const navigate = useNavigate()
	const modules = useModules()
	const all = useNotifications()
	const api = platform.systemNotifications

	useEffect(() => {
		if (!api) return
		const supporting = new Set(modules.filter(m => m.supports?.includes('notifications')).map(m => m.id))
		api.sync(all
			.filter(n => supporting.has(n.module))
			.map(n => ({ id: n.id, title: n.title, body: n.body, count: n.count, link: n.link })))
	}, [api, all, modules])

	useEffect(() => api?.onOpen(link => navigate(link)), [api, navigate])

	// Android: the system shows them from the server's pushes; this device registers, a tap opens
	useEffect(() => {
		if (!platform.push) return
		void registerPushDevice()
		return platform.push.onOpen(link => navigate(link))
	}, [navigate])

	return null
}
