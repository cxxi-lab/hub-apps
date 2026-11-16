import { useState } from 'react'
import { Switch } from '@cxxi-lab/hub-ui'
import { setDeveloperMode, useDeveloperMode } from '@core/settings/developer'
import { isLocalFirst, localFirstAvailable, setLocalFirst } from '@core/sync/mode'

/** The modules the local-first trial covers (docs/plan-local-first.md § 6); Planner and Workouts migrated (core/sync/mode.ts). */
const LOCAL_FIRST_TRIAL: Array<{ id: string, label: string }> = []

function LocalFirstTrial() {
	const [, refresh] = useState(0)
	if (!localFirstAvailable() || LOCAL_FIRST_TRIAL.length === 0) return null
	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-3">
			<div>
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Local-first (trial)</h2>
				<p className="m-0 text-xs text-steel-300">
					The module's data in this device's base, synced with your other devices through the server, which only relays it encrypted. During the trial the server's copy is kept up to date too; writes made on a device not in the trial don't come back here. The app reloads when switched.
				</p>
			</div>
			{LOCAL_FIRST_TRIAL.map(m => (
				<div key={m.id} className="flex items-center gap-4">
					<span className="flex-1 text-sm text-white">{m.label}</span>
					<Switch checked={isLocalFirst(m.id)} onChange={next => { setLocalFirst(m.id, next); refresh(n => n + 1) }}
						title={isLocalFirst(m.id) ? `Back to the server for ${m.label}` : `${m.label} local-first on this device`} />
				</div>
			))}
		</section>
	)
}

export function SettingsDeveloper() {
	const on = useDeveloperMode()
	const [error, setError] = useState<string | null>(null)

	const change = (next: boolean) => {
		setError(null)
		setDeveloperMode(next).catch(() => setError('Save failed'))
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
				<div className="flex-1 min-w-0">
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Developer mode</h2>
					<p className="m-0 text-xs text-steel-300">
						The status bar and its console on desktop; on the phone, the console on a double tap of the logo.
					</p>
					{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
				</div>
				<Switch checked={on} onChange={change} title={on ? 'Turn developer mode off' : 'Turn developer mode on'} />
			</section>
			<LocalFirstTrial />
		</div>
	)
}
