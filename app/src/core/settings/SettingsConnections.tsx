import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { connect, fetchConnections, removeConnection, type ConnectProvider, type Connection } from '@core/api/connections'
import { errorMessage } from '@core/api/client'

const USE_LABELS: Record<string, string> = { mail: 'Mail', drive: 'Drive' }
const useLabel = (use: string) => USE_LABELS[use] ?? use

/**
 * The accounts connected at a provider (Google, Microsoft): one per account, reused by everything
 * that needs it (Mail, Storage…). A use added later asks the provider for that access only. The
 * consent opens in the browser; the server takes the provider's answer.
 */
export function SettingsConnections() {
	const [connections, setConnections] = useState<Connection[] | null>(null)
	const [providers, setProviders] = useState<ConnectProvider[]>([])
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	// the consent waited for (in the browser), to stop waiting
	const waiting = useRef<AbortController | null>(null)
	useEffect(() => () => waiting.current?.abort(), [])

	const load = useCallback(() => fetchConnections()
		.then(d => { setConnections(d.connections); setProviders(d.providers) })
		.catch(e => setError(errorMessage(e))), [])
	useEffect(() => { void load() }, [load])

	const consent = (key: string, provider: string, use: string, connection?: string) => {
		const controller = new AbortController()
		waiting.current = controller
		return run(key, () => connect(provider, use, connection, controller.signal))
	}

	const run = async (key: string, action: () => Promise<unknown>) => {
		setBusy(key)
		setError(null)
		try {
			await action()
			await load()
		}
		catch (e) {
			setError(errorMessage(e))
		}
		finally {
			setBusy(null)
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-4">
				<div>
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Connected accounts</h2>
					<p className="m-0 text-xs text-steel-300">
						Accounts the hub may use for you. Their access stays on the server, sealed; disconnecting asks the provider to drop it.
					</p>
					{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
					{busy !== null && !busy.endsWith('/remove') && (
						<p className="m-0 mt-1 text-xs text-steel-300">
							Finish in the browser that just opened, then come back here.{' '}
							<button type="button" className="text-primary-400 underline" onClick={() => waiting.current?.abort()}>Cancel</button>
						</p>
					)}
				</div>
				{connections === null && !error && <p className="m-0 text-xs text-steel-400">Loading…</p>}
				{connections?.length === 0 && <p className="m-0 text-xs text-steel-400">No connected account yet.</p>}
				{connections?.map(c => {
					const provider = providers.find(p => p.id === c.provider)
					const missing = (provider?.uses ?? []).filter(u => !c.uses.includes(u))
					return (
						<div key={c.id} className="flex flex-wrap items-center gap-3 border-t border-steel-800 pt-3">
							<div className="flex-1 min-w-0">
								<div className="text-sm text-white truncate">{c.email}</div>
								<div className="text-xs text-steel-400">
									{provider?.label ?? c.provider} · {c.uses.length > 0 ? c.uses.map(useLabel).join(', ') : 'no access'}
									{c.lastUsedAt && ` · used ${new Date(c.lastUsedAt).toLocaleDateString()}`}
								</div>
								{c.lastError && <div className="text-xs text-red-300 truncate" title={c.lastError}>{c.lastError}</div>}
							</div>
							{missing.map(use => (
								<Button key={use} label={`Allow ${useLabel(use)}`} color="secondary"
									isLoading={busy === `${c.id}/${use}`} isDisabled={busy !== null}
									onClick={() => void consent(`${c.id}/${use}`, c.provider, use, c.id)} />
							))}
							<Button label="Disconnect" color="secondary" isLoading={busy === `${c.id}/remove`} isDisabled={busy !== null}
								onClick={() => void run(`${c.id}/remove`, () => removeConnection(c.id))} />
						</div>
					)
				})}
			</section>

			<section className="bg-steel-900 border border-steel-700 rounded-md p-5 flex flex-col gap-3">
				<h2 className="m-0 text-sm font-semibold text-white uppercase tracking-wider">Connect an account</h2>
				{providers.map(p => (
					<div key={p.id} className="flex flex-wrap items-center gap-3">
						<span className="flex-1 min-w-0 text-sm text-white">{p.label}</span>
						{!p.configured && <span className="text-xs text-steel-400">No OAuth client on the server</span>}
						{p.configured && p.uses.map(use => (
							<Button key={use} label={`Connect for ${useLabel(use)}`} color="secondary"
								isLoading={busy === `${p.id}/${use}`} isDisabled={busy !== null}
								onClick={() => void consent(`${p.id}/${use}`, p.id, use)} />
						))}
					</div>
				))}
			</section>
		</div>
	)
}
