import { useEffect, useState, useSyncExternalStore } from 'react'
import { Button, Modal } from '@cxxi-lab/hubbyware-ui'
import { platform, type ModelPlan } from '@platform'

/**
 * The user's agreement to a hubby's AI model on this device, asked the first time it needs it
 * (`ai.chat`, client docs/plan-ia-moteur.md § 5-6; the AI models screen of Settings allows it ahead):
 * the model, its size, how it fits this device; Download, then its progress until it is here. Asked
 * by the app, outside the hubby's frame. One question at a time.
 */

interface Ask { plan: ModelPlan, resolve: (ok: boolean) => void }

const queue: Ask[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(l => l())
const current = () => queue[0] ?? null

/** Asks (one question at a time): true once the model is here, false if the user declined or it failed. */
export async function askModelConsent(hubby: string, name: string): Promise<boolean> {
	const models = platform.localModels
	if (!models) return false
	const plan = (await models.state()).plans.find(p => p.hubby === hubby && p.name === name)
	if (!plan || plan.chosen === null) return false
	return new Promise(resolve => {
		queue.push({ plan, resolve })
		changed()
	})
}

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 2 ** 30 ? 2 : 1)} GB`

export function ModelConsent() {
	const ask = useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, current)
	const [plan, setPlan] = useState<ModelPlan | null>(null)
	const [downloading, setDownloading] = useState(false)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => { setPlan(ask?.plan ?? null); setDownloading(false); setError(null) }, [ask])

	// its progress, until it is here
	useEffect(() => {
		const models = platform.localModels
		if (!ask || !downloading || !models) return
		const refresh = () => void models.state().then(s => {
			const next = s.plans.find(p => p.hubby === ask.plan.hubby && p.name === ask.plan.name) ?? null
			setPlan(next)
			if (next?.installed && next.consented) finish(true)
		})
		const offChange = models.onChange(refresh)
		const offFailure = models.onFailure(f => { if (f.hubby === ask.plan.hubby && f.name === ask.plan.name) { setError(f.error); setDownloading(false) } })
		refresh()
		return () => { offChange(); offFailure() }
	}, [ask, downloading])

	if (!ask || !plan || plan.chosen === null) return null
	const variant = plan.variants[plan.chosen]
	function finish(ok: boolean) {
		queue.shift()?.resolve(ok)
		changed()
	}
	const download = () => {
		setError(null)
		setDownloading(true)
		void platform.localModels?.download(plan.hubby, plan.name)
	}
	const progress = plan.download
	return (
		<Modal title={plan.installed ? 'Use an AI model?' : 'Download an AI model?'} size="sm" onClose={() => finish(false)}>
			<div className="flex flex-col gap-3 text-sm text-steel-200">
				<p className="m-0"><b className="text-white">{plan.hubbyLabel}</b> wants to use an AI model on this device{plan.description ? `: ${plan.description.charAt(0).toLowerCase()}${plan.description.slice(1)}` : ''}.</p>
				<p className="m-0 text-xs text-steel-300 break-all">{variant.repo} · {gb(variant.sizeBytes)}{variant.fit === 'slow' ? ` · ${variant.reason}` : ''}</p>
				<p className="m-0 text-xs text-steel-400">It runs here: nothing you ask it leaves this device. Downloaded from Hugging Face, checked; you can delete it in Settings › AI models.</p>
				{downloading && (
					<div className="flex flex-col gap-1">
						<div className="h-1.5 w-full rounded bg-steel-800 overflow-hidden">
							<div className="h-full bg-primary-500" style={{ width: `${progress ? Math.round((progress.received / progress.total) * 100) : 0}%` }} />
						</div>
						<span className="text-xs text-steel-400">{progress ? `${gb(progress.received)} / ${gb(progress.total)}` : 'Starting…'}</span>
					</div>
				)}
				{error && <p className="m-0 text-xs text-red-300">{error}</p>}
				<div className="flex justify-end gap-2">
					<Button label="Not now" color="secondary" onClick={() => finish(false)} />
					{!downloading && <Button label={plan.installed ? 'Allow' : `Download (${gb(variant.sizeBytes)})`} onClick={download} />}
				</div>
			</div>
		</Modal>
	)
}
