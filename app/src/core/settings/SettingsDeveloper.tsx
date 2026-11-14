import { useState } from 'react'
import { Switch } from '@cxxi-lab/hub-ui'
import { setDeveloperMode, useDeveloperMode } from '@core/settings/developer'

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
		</div>
	)
}
