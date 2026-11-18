import { useSyncExternalStore } from 'react'
import { Button, Modal } from '@cxxi-lab/hubbyware-ui'
import type { AgentTool } from './agent'

/**
 * The user's go-ahead to an AI assistant's action (client docs/plan-ia-agent.md D3): asked by the app,
 * outside every hubby's frame, before a `write` (allowed once, or for the whole conversation) or an
 * `outward` one (allowed once only: it reaches outside Hubbyware, or can't be undone). One at a time.
 */

export type AgentAnswer = 'allow' | 'always' | 'deny'
interface Ask { tool: AgentTool, input: unknown, resolve: (a: AgentAnswer) => void }

const queue: Ask[] = []
const listeners = new Set<() => void>()
const changed = () => listeners.forEach(l => l())

export function askAgentConfirmation(tool: AgentTool, input: unknown): Promise<AgentAnswer> {
	return new Promise(resolve => { queue.push({ tool, input, resolve }); changed() })
}

function answer(a: AgentAnswer) {
	queue.shift()?.resolve(a)
	changed()
}

export function AgentConfirm() {
	const ask = useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l) } }, () => queue[0] ?? null)
	if (!ask) return null
	const { tool, input } = ask
	const shown = JSON.stringify(input, null, 2)
	return (
		<Modal title={tool.effect === 'outward' ? 'Let the assistant do this?' : 'Let the assistant change this?'} size="sm" onClose={() => answer('deny')}>
			<div className="flex flex-col gap-3 text-sm text-steel-200" data-testid="agent-confirm" data-effect={tool.effect}>
				<p className="m-0">The assistant wants to use <b className="text-white">{tool.hubbyLabel}</b>: {tool.description}</p>
				{tool.effect === 'outward' && <p className="m-0 text-xs text-amber-300">This reaches outside Hubbyware or can't be undone.</p>}
				<pre className="m-0 max-h-60 overflow-auto rounded bg-steel-950 border border-steel-800 p-2 text-xs text-steel-100 whitespace-pre-wrap break-words">{shown.length > 4000 ? `${shown.slice(0, 4000)}\n…` : shown}</pre>
				<div className="flex flex-wrap justify-end gap-2">
					<Button label="Deny" color="secondary" onClick={() => answer('deny')} />
					{tool.effect === 'write' && <Button label="Always in this conversation" color="secondary" onClick={() => answer('always')} />}
					<Button label="Allow" onClick={() => answer('allow')} />
				</div>
			</div>
		</Modal>
	)
}
