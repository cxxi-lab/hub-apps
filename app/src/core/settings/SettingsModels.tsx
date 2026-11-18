import { useCallback, useEffect, useState } from 'react'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { platform } from '@platform'
import type { LocalModelsApi, LocalModelsState, ModelFit, ModelPlan } from '@platform'
import { errorMessage } from '@core/api/client'

/**
 * The AI models on this device (client docs/plan-ia-moteur.md § 5): the ones the hubbies declare,
 * how each fits this device (its GPU, RAM, disk), downloaded only once the user agreed here (or at
 * a hubby's first use); the ones here, their size, who uses them, deleted. They run on the device,
 * nothing leaves it; downloaded straight from Hugging Face, each file checked.
 */

const gb = (bytes: number) => `${(bytes / 2 ** 30).toFixed(bytes < 2 ** 30 ? 2 : 1)} GB`
const FIT: Record<ModelFit, { label: string, tone: string }> = {
	runs: { label: 'This device can run it', tone: 'text-emerald-300' },
	slow: { label: 'Runs slowly here', tone: 'text-amber-300' },
	cannot: { label: 'Too large for this device', tone: 'text-red-300' }
}

function ModelRow({ plan, models, onError }: { plan: ModelPlan, models: LocalModelsApi, onError: (e: string) => void }) {
	if (plan.invalid) {
		return (
			<div className="border-t border-steel-800 pt-3 text-xs">
				<div className="text-sm text-white">{plan.hubbyLabel} · {plan.name}</div>
				<div className="text-red-300">Refused: {plan.invalid}</div>
			</div>
		)
	}
	const variant = plan.chosen !== null ? plan.variants[plan.chosen] : plan.variants.at(-1)!
	const fit = FIT[variant.fit]
	const downloading = plan.download
	return (
		<div className="flex flex-wrap items-center gap-3 border-t border-steel-800 pt-3">
			<div className="flex-1 min-w-0">
				<div className="text-sm text-white truncate">{plan.hubbyLabel} · {plan.name} <span className="text-xs text-steel-400">({plan.family})</span></div>
				{plan.description && <div className="text-xs text-steel-300">{plan.description}</div>}
				<div className="text-xs text-steel-400 truncate" title={`${variant.repo}@${variant.revision}`}>{variant.repo} · {gb(variant.sizeBytes)}</div>
				<div className={`text-xs ${fit.tone}`}>{fit.label}: {variant.reason}</div>
				{plan.variants.length > 1 && <div className="text-xs text-steel-500">{plan.variants.length} sizes declared; this device uses the {plan.chosen === 0 ? 'largest' : plan.chosen === null ? 'none' : 'one it can run'}</div>}
				{downloading && (
					<div className="mt-1 h-1.5 w-full max-w-xs rounded bg-steel-800 overflow-hidden">
						<div className="h-full bg-primary-500" style={{ width: `${Math.round((downloading.received / downloading.total) * 100)}%` }} />
					</div>
				)}
			</div>
			<div className="shrink-0 text-xs">
				{plan.installed && plan.consented ? <span className="text-emerald-300">Downloaded</span>
					: downloading ? <span className="text-steel-300">{gb(downloading.received)} / {gb(downloading.total)}</span>
					: plan.chosen !== null ? <Button label={plan.installed ? 'Allow' : `Download (${gb(variant.sizeBytes)})`} onClick={() => void models.download(plan.hubby, plan.name).catch(e => onError(errorMessage(e)))} />
					: null}
			</div>
		</div>
	)
}

export function SettingsModels() {
	const models = platform.localModels
	const [state, setState] = useState<LocalModelsState | null>(null)
	const [error, setError] = useState<string | null>(null)
	const load = useCallback(() => models?.state().then(setState).catch(e => setError(errorMessage(e))), [models])
	useEffect(() => {
		if (!models) return
		void load()
		const offChange = models.onChange(() => void load())
		const offFailure = models.onFailure(f => setError(`${f.hubby} ${f.name}: ${f.error}`))
		return () => { offChange(); offFailure() }
	}, [models, load])

	if (!models) return <p className="m-0 text-xs text-steel-400">AI models don't run on this device yet.</p>
	const device = state?.device
	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
				<div>
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Models your hubbies use</h2>
					<p className="m-0 text-xs text-steel-300">
						They run on this device: nothing you ask them leaves it. Downloaded from Hugging Face once you allow them here (or when a hubby first needs one), each file checked.
					</p>
					{device && (
						<p className="m-0 mt-1 text-xs text-steel-400">
							This device: {device.gpu ? `${device.gpu.label} (${(device.gpu.vramMib / 1024).toFixed(0)} GB)` : 'no dedicated GPU'} · {(device.ramMib / 1024).toFixed(0)} GB of RAM · {(device.freeDiskMib / 1024).toFixed(0)} GB free
						</p>
					)}
					{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
				</div>
				{state === null && !error && <p className="m-0 text-xs text-steel-400">Loading…</p>}
				{state?.plans.length === 0 && <p className="m-0 text-xs text-steel-400">None of your hubbies uses an AI model.</p>}
				{state?.plans.map(p => <ModelRow key={`${p.hubby}/${p.name}`} plan={p} models={models} onError={setError} />)}
			</section>
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
				<div>
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">On this device</h2>
					<p className="m-0 text-xs text-steel-300 break-all">
						Kept once, whichever hubbies use them, in {device?.directory ?? '…'}{' '}
						<button type="button" className="text-primary-400 underline" onClick={() => models.chooseDirectory().then(() => load()).catch(e => setError(errorMessage(e)))}>Change</button>
					</p>
				</div>
				{state?.installed.length === 0 && <p className="m-0 text-xs text-steel-400">No model downloaded.</p>}
				{state?.installed.map(m => (
					<div key={m.sha256} className="flex flex-wrap items-center gap-3 border-t border-steel-800 pt-3">
						<div className="flex-1 min-w-0">
							<div className="text-sm text-white truncate" title={`${m.repo}@${m.revision}`}>{m.path}</div>
							<div className="text-xs text-steel-400">{m.repo} · {gb(m.sizeBytes)} · used by {m.users.map(u => {
								const plan = state.plans.find(p => `${p.hubby}/${p.name}` === u)
								return plan ? `${plan.hubbyLabel} · ${plan.name}` : u.replace('/', ' · ')
							}).join(', ') || 'nobody'}</div>
						</div>
						<Button label="Delete" color="secondary" onClick={() => void models.remove(m.sha256).then(() => load()).catch(e => setError(errorMessage(e)))} />
					</div>
				))}
			</section>
		</div>
	)
}
