import type { HubbyManifest } from '@core/hubby/types'
import { Switch } from '@cxxi-lab/hubbyware-ui'

/** A hubby's place in the top bar (its settings' common part, for an enabled hubby): pinned or not. */
export function PinSettings({ hubby: m, pinned, onChange }: { hubby: HubbyManifest, pinned: boolean, onChange: (on: boolean) => void }) {
	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex items-center gap-4">
			<div className="flex-1 min-w-0">
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Top bar</h2>
				<p className="m-0 text-xs text-steel-300">Pin {m.label} to the top bar; unpinned, it stays on the home page.</p>
			</div>
			<Switch checked={pinned} onChange={onChange} title={pinned ? 'Unpin from the top bar' : 'Pin to the top bar'} />
		</section>
	)
}
