import { useState } from 'react'
import type { ModuleManifest } from '@core/module/types'
import { grantScopes, revokeScope, useModuleScopes } from '@core/modules/scopes'
import { Switch } from '@cxxi-lab/hub-ui'

const FAMILY: Record<string, string> = { app: 'App', module: 'Other modules', user: 'Your account' }

/**
 * A module's permissions (its settings' common part): the scopes it asks for, each allowed or not;
 * the ones that come with an official module are shown, not switchable.
 */
export function PermissionsSettings({ module: m }: { module: ModuleManifest }) {
	const scopes = useModuleScopes()
	const [error, setError] = useState<string | null>(null)
	const entry = scopes?.[m.id]
	if (!entry || entry.requested.length === 0) return null

	const change = (scope: string, on: boolean) => {
		setError(null)
		;(on ? grantScopes(m.id, [scope]) : revokeScope(m.id, scope)).catch(() => setError('Save failed'))
	}

	return (
		<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-3">
			<div>
				<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Permissions</h2>
				<p className="m-0 text-xs text-steel-300">What {m.label} may use. Turned off, that part of it stops working.</p>
				{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
			</div>
			<ul className="m-0 p-0 list-none flex flex-col gap-2">
				{entry.requested.map(r => {
					const on = entry.granted.includes(r.scope)
					return (
						<li key={r.scope} className="flex items-center gap-3">
							<span className="flex-1 min-w-0">
								<span className="block text-sm text-steel-100">{r.label}</span>
								<span className="block text-[11px] text-steel-500">{FAMILY[r.family] ?? r.family} · <code className="text-steel-500">{r.scope}</code></span>
							</span>
							{r.builtIn
								? <span className="shrink-0 text-[11px] text-steel-400">Built in</span>
								: <Switch checked={on} onChange={next => change(r.scope, next)} title={on ? 'Revoke' : 'Allow'} />}
						</li>
					)
				})}
			</ul>
		</section>
	)
}
