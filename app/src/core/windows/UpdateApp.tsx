import { useEffect, useState } from 'react'
import { Button } from '@cxxi-lab/hub-ui'
import type { UpdateState } from '@platform'
import { platform } from '@platform'

function formatMegabytes(bytes: number): string {
	return `${(bytes / 1_048_576).toFixed(1)} MB`
}

/**
 * Update window, shown in place of the app while an update is pending: offers the
 * update, then follows its download, signature check and install (driven by the
 * main process updater). Shells without native windows show it as an overlay
 * ({@link UpdateGate}); there the app can't be quit, so "Quit" becomes "Later".
 */
export function UpdateApp({ onSkip }: { onSkip?: () => void } = {}) {
	const [state, setState] = useState<UpdateState | null>(null)

	useEffect(() => {
		platform.getUpdateState().then(setState).catch(() => {})
		return platform.onUpdateStateChange(setState)
	}, [])

	if (!state) {
		return <div className="h-screen bg-steel-950" />
	}

	const { phase, version, currentVersion, progress, error } = state
	const canQuit = platform.capabilities.nativeWindows
	const skip = () => {
		void platform.skipUpdate()
		onSkip?.()
	}
	const busy = phase === 'downloading' || phase === 'verifying' || phase === 'installing'

	const title = phase === 'available' ? 'Update available'
		: phase === 'downloading' ? `Downloading v${version}…`
		: phase === 'verifying' ? 'Verifying release signature…'
		: phase === 'installing' ? 'Installing, hub will restart…'
		: 'Update failed'

	return (
		<div className="flex flex-col h-screen bg-steel-950 text-steel-100 p-6 gap-4 select-none">
			<div className="flex flex-col gap-1.5">
				<h1 className="text-lg font-semibold text-white m-0">{title}</h1>
				<p className="text-sm text-steel-300 m-0">
					{phase === 'error'
						? `Version ${version} was not installed.`
						: `Version ${version} (current: ${currentVersion}). hub must be updated before it can be used.`}
				</p>
			</div>

			{busy && (
				<div className="flex flex-col gap-2">
					<div className="h-1.5 w-full rounded-full bg-steel-800 overflow-hidden">
						{phase === 'downloading' && progress ? (
							<div className="h-full bg-primary-500 transition-[width] duration-300" style={{ width: `${Math.min(100, progress.percent)}%` }} />
						) : phase === 'installing' ? (
							<div className="h-full w-full bg-primary-500" />
						) : (
							<div className="h-full w-1/3 bg-primary-500 animate-pulse" />
						)}
					</div>
					<div className="text-xs text-steel-300 font-mono tabular-nums">
						{phase === 'downloading'
							? progress
								? `${Math.floor(progress.percent)}% · ${formatMegabytes(progress.transferred)} / ${formatMegabytes(progress.total)} · ${formatMegabytes(progress.bytesPerSecond)}/s`
								: 'Starting download…'
							: phase === 'verifying' ? 'Checking the download against the signed manifest'
							: 'Restarting in a moment'}
					</div>
				</div>
			)}

			{phase === 'error' && error && (
				<div className="text-xs text-red-300 font-mono break-words">{error}</div>
			)}

			<div className="mt-auto flex justify-end gap-2">
				{phase === 'available' && (
					<>
						{canQuit
							? <Button color="secondary" label="Quit" onClick={() => platform.quitApp()} />
							: <Button color="secondary" label="Later" onClick={skip} />}
						<Button label="Update" onClick={() => platform.installUpdate()} />
					</>
				)}
				{phase === 'error' && (
					<>
						{canQuit && <Button color="secondary" label="Quit" onClick={() => platform.quitApp()} />}
						<Button color="secondary" label="Open without updating" onClick={skip} />
						<Button label="Retry" onClick={() => platform.installUpdate()} />
					</>
				)}
			</div>
		</div>
	)
}

/**
 * In-app counterpart of the desktop update window, for shells without native
 * windows (mobile): covers the app while an update is offered or in progress.
 */
export function UpdateGate() {
	const [pending, setPending] = useState(false)

	useEffect(() => {
		platform.getUpdateState().then(state => setPending(state !== null)).catch(() => {})
		return platform.onUpdateStateChange(() => setPending(true))
	}, [])

	if (!pending) return null
	return (
		<div className="fixed inset-0 z-200">
			<UpdateApp onSkip={() => setPending(false)} />
		</div>
	)
}
