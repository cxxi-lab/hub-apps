import { useEffect, useState } from 'react'
import { fetchSettings, updateSettings } from '@core/api/settings'
import type { HubbyManifest } from '@core/hubby/types'
import { Switch } from '@cxxi-lab/hubbyware-ui'

/**
 * A hubby's notifications (its settings' common part, for a hubby that supports them): on or off
 * (its `<hubby>.notifications` setting). Off, it sends none and its badge goes.
 */
export function NotificationsSettings({ hubby: m }: { hubby: HubbyManifest }) {
	const [on, setOn] = useState<boolean | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		fetchSettings<{ notifications?: boolean }>(m.id)
			.then(s => setOn(s.notifications ?? true))
			.catch(() => setError('Failed to load'))
	}, [m.id])

	const change = (next: boolean) => {
		const previous = on
		setOn(next)
		setError(null)
		updateSettings(m.id, { notifications: next }).catch(() => {
			setOn(previous)
			setError('Save failed')
		})
	}

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
			<div className="flex-1 min-w-0">
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Notifications</h2>
				<p className="m-0 text-xs text-steel-300">
					{m.label}'s notifications in the menu, and its badge in the top bar.
				</p>
				{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
			</div>
			{on !== null && <Switch checked={on} onChange={change} title={on ? 'Turn notifications off' : 'Turn notifications on'} />}
		</section>
	)
}
