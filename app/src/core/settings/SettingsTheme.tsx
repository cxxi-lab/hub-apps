import { faCircleHalfStroke, faMoon, faSun } from '@fortawesome/free-solid-svg-icons'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { setThemeMode, useThemeMode, type ThemeMode } from '@core/theme/theme'

const MODES: Array<{ id: ThemeMode; label: string; icon: typeof faSun; hint: string }> = [
	{ id: 'auto', label: 'Auto', icon: faCircleHalfStroke, hint: "The system's, followed as it changes" },
	{ id: 'light', label: 'Light', icon: faSun, hint: 'Always light' },
	{ id: 'dark', label: 'Dark', icon: faMoon, hint: 'Always dark' },
]

/** The theme of this device: auto (the system's), light or dark. */
export function SettingsTheme() {
	const mode = useThemeMode()

	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
				<div>
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Mode</h2>
					<p className="m-0 text-xs text-steel-300">For this device. Auto follows the system's light or dark setting.</p>
				</div>
				<div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 gap-3 max-w-md">
					{MODES.map(m => {
						const active = m.id === mode
						return (
							<button
								key={m.id}
								type="button"
								role="radio"
								aria-checked={active}
								title={m.hint}
								onClick={() => setThemeMode(m.id)}
								className={`flex flex-col items-center gap-2 py-4 rounded-md border text-sm cursor-pointer transition-colors ${active
									? 'border-primary-500 bg-primary-700 text-white'
									: 'border-steel-700 bg-steel-950 text-steel-100 hover:border-steel-500'}`}
							>
								<FontAwesomeIcon icon={m.icon} className={`text-lg ${active ? 'text-primary-500' : 'text-steel-300'}`} />
								{m.label}
							</button>
						)
					})}
				</div>
			</section>
		</div>
	)
}
