import { useEffect, useState } from 'react'
import { fetchSettings, updateSettings } from '@core/api/settings'

const MIN = 10
const MAX = 500

/** The account's notifications: how many are kept (the oldest go). Each module's are on or off in its settings (Modules). */
export function SettingsNotifications() {
	const [saved, setSaved] = useState<number | null>(null)
	const [value, setValue] = useState('')
	const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle')

	useEffect(() => {
		fetchSettings<{ history_size: number }>('notifications')
			.then(s => { setSaved(s.history_size); setValue(String(s.history_size)) })
			.catch(() => setState('Failed to load'))
	}, [])

	const save = () => {
		const next = Number(value)
		if (!Number.isInteger(next) || next < MIN || next > MAX) {
			setState(`Between ${MIN} and ${MAX}`)
			return
		}
		if (next === saved) return
		setState('saving')
		updateSettings('notifications', { history_size: next })
			.then(s => { setSaved(s.history_size as number); setState('saved') })
			.catch(() => setState('Save failed'))
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
				<div className="flex-1 min-w-0">
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">History</h2>
					<p className="m-0 text-xs text-steel-300">
						How many notifications are kept, all modules together: past it, the oldest go. Each module's notifications are turned on or off in its settings (Modules).
					</p>
					{state !== 'idle' && state !== 'saving' && (
						<p className={`m-0 mt-1 text-xs ${state === 'saved' ? 'text-steel-300' : 'text-red-300'}`}>{state === 'saved' ? 'Saved' : state}</p>
					)}
				</div>
				<input
					type="number"
					min={MIN}
					max={MAX}
					value={value}
					disabled={saved === null}
					onChange={e => { setValue(e.target.value); setState('idle') }}
					onBlur={save}
					onKeyDown={e => { if (e.key === 'Enter') save() }}
					className="w-24 h-9 px-3 text-sm text-white bg-steel-950 border border-steel-700 rounded outline-none focus:border-primary-500 tabular-nums"
				/>
			</section>
		</div>
	)
}
