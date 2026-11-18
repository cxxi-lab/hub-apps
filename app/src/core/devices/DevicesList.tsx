import { useCallback, useEffect, useState } from 'react'
import { Button } from '@cxxi-lab/hubbyware-ui'
import { fetchSessions, revokeSession, type DeviceSession } from '@core/api/sessions'
import { errorMessage } from '@core/api/client'

/** What a user agent says, shortly: the app and its version, the system. */
export function describe(session: Pick<DeviceSession, 'userAgent' | 'client'>): { name: string; detail: string | null } {
	const agent = session.userAgent ?? ''
	const app = agent.match(/\bhub(?:-dev)?\/([\d.]+)/i)?.[1]
	const android = agent.match(/Android ([\d.]+)/)?.[1]
	const system = android ? `Android ${android}`
		: /Windows/.test(agent) ? 'Windows'
		: /Mac OS X/.test(agent) ? 'macOS'
		: /Linux/.test(agent) ? 'Linux'
		: null
	const name = session.client === 'desktop' ? (/\bhub-dev\//i.test(agent) ? 'Desktop app (dev)' : 'Desktop app')
		: session.client === 'android' ? 'Android app'
		: session.client ?? 'Unknown device'
	const detail = [system, app ? `v${app}` : null].filter(Boolean).join(' · ')

	return { name, detail: detail || null }
}

function ago(iso: string | null): string {
	if (!iso) return 'unknown'
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
	if (seconds < 90) return 'just now'
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.round(minutes / 60)
	if (hours < 48) return `${hours} h ago`
	return new Date(iso).toLocaleDateString()
}

/**
 * The devices signed in to the account (its sessions): which app, from where, since when, last
 * active. Another one can be signed out from here; its access stops at once.
 */
export function DevicesList() {
	const [sessions, setSessions] = useState<DeviceSession[] | null>(null)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const load = useCallback(() => fetchSessions().then(setSessions).catch(e => setError(errorMessage(e))), [])
	useEffect(() => { void load() }, [load])

	const revoke = async (id: string) => {
		setBusy(id)
		setError(null)
		try {
			await revokeSession(id)
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
					<h2 className="m-0 mb-1 text-sm font-semibold text-white uppercase tracking-wider">Signed-in devices</h2>
					<p className="m-0 text-xs text-steel-300">
						Every device signed in to this account, with the address and browser the server last saw (kept encrypted). Signing one out stops its access at once.
					</p>
					{error && <p className="m-0 mt-1 text-xs text-red-300">{error}</p>}
				</div>
				{sessions === null && !error && <p className="m-0 text-xs text-steel-400">Loading…</p>}
				{sessions?.map(s => {
					const { name, detail } = describe(s)
					return (
						<div key={s.id} className="flex flex-wrap items-center gap-3 border-t border-steel-800 pt-3">
							<div className="flex-1 min-w-0">
								<div className="text-sm text-white flex items-center gap-2">
									<span className="truncate">{name}</span>
									{s.current && <span className="text-[10px] uppercase tracking-wider text-primary-400 border border-primary-500/50 rounded px-1.5 py-px">This device</span>}
								</div>
								<div className="text-xs text-steel-400">
									{[detail, s.ip].filter(Boolean).join(' · ') || 'Not seen since devices are tracked: shows after its next refresh'}
								</div>
								<div className="text-xs text-steel-500">
									Active {ago(s.lastUsedAt)}{s.createdAt && ` · signed in ${new Date(s.createdAt).toLocaleDateString()}`}
								</div>
								{s.userAgent && <div className="text-[11px] text-steel-600 truncate" title={s.userAgent}>{s.userAgent}</div>}
							</div>
							{!s.current && (
								<Button label="Sign out" color="secondary" isLoading={busy === s.id} isDisabled={busy !== null}
									onClick={() => void revoke(s.id)} />
							)}
						</div>
					)
				})}
			</section>
		</div>
	)
}
