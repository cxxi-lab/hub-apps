import { useState } from 'react'
import { errorMessage } from '@core/api/client'
import type { ModuleManifest, StorageScope } from '@core/module/types'
import { modeOf, moveScope, useStorageModes, type MoveProgress, type StorageMode } from '@core/storage/store'
import { platform } from '@platform'
import { Button, ConfirmationModal } from '@cxxi-lab/hub-ui'

const WHERE: Record<StorageMode, string> = {
	server: 'On the server: shared by your devices.',
	local: 'On each device: never sent to the server, not shared.'
}

const STEP: Record<MoveProgress['step'], string> = {
	reading: 'Reading…',
	documents: 'Copying…',
	files: 'Copying files…',
	checking: 'Checking…',
	cleaning: 'Removing the old copy…',
	done: 'Done'
}

/**
 * Where a module's data lives (its settings' common part, for a module declaring storage scopes):
 * each scope on the server (shared by the devices) or on each device. Changing it moves the data:
 * copied, checked, then removed from where it was.
 */
export function DataSettings({ module: m }: { module: ModuleManifest }) {
	useStorageModes(m.id)
	const scopes = (m.storage?.scopes ?? []).filter(s => s.modes.length > 1)
	if (scopes.length === 0) return null

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
			<div>
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Data</h2>
				<p className="m-0 text-xs text-steel-300">Where {m.label}'s data lives, part by part.</p>
			</div>
			{scopes.map(scope => <ScopeRow key={scope.id} module={m} scope={scope} />)}
		</section>
	)
}

function ScopeRow({ module: m, scope }: { module: ModuleManifest, scope: StorageScope }) {
	const mode = modeOf(m.id, scope.id)
	const to: StorageMode = mode === 'server' ? 'local' : 'server'
	const [asking, setAsking] = useState(false)
	const [progress, setProgress] = useState<MoveProgress | null>(null)
	const [error, setError] = useState<string | null>(null)
	// moving to this device needs a local store here
	const possible = to === 'server' || !!platform.localStore

	const move = async () => {
		setAsking(false)
		setError(null)
		try {
			await moveScope(m.id, scope.id, to, setProgress)
		}
		catch (err) {
			setError(errorMessage(err))
		}
		finally {
			setProgress(null)
		}
	}

	return (
		<div className="flex items-center gap-3">
			<div className="flex-1 min-w-0">
				<div className="text-sm text-white">{scope.label}</div>
				<div className="text-xs text-steel-300">
					{progress ? `${STEP[progress.step]}${progress.total ? ` ${progress.done}/${progress.total}` : ''}` : WHERE[mode]}
					{scope.perItem && !progress && ' Each item can say otherwise.'}
				</div>
				{error && <div className="text-xs text-red-300">{error}</div>}
			</div>
			{possible && (
				<Button
					label={to === 'local' ? 'Keep on this device' : 'Move to the server'}
					color="secondary"
					isLoading={!!progress}
					onClick={() => setAsking(true)}
				/>
			)}
			{asking && (
				<ConfirmationModal
					title={to === 'local' ? `Keep ${scope.label} on each device` : `Move ${scope.label} to the server`}
					confirmLabel="Move"
					onConfirm={() => void move()}
					onClose={() => setAsking(false)}
				>
					<p className="m-0 text-sm text-steel-300">
						{to === 'local'
							? "Its data comes to this device and leaves the server. Your other devices won't have it any more."
							: "This device's data goes to the server, shared by your devices, and leaves this device."}
					</p>
				</ConfirmationModal>
			)}
		</div>
	)
}
