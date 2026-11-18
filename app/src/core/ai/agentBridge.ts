import { platform } from '@platform'
import { agentCall, agentTools, type AgentCallResult } from './agent'

/**
 * The app's side of Hubbyware's MCP server (client docs/plan-ia-agent.md, phase 3): a device agent's
 * requests (main ai/mcp.ts) answered with the assistant's catalogue and calls (agent.ts) — the same
 * hubbies opened to it, the same confirmations. Each call is announced (onAgentCall) for the
 * conversation's trace.
 */

type CallListener = (conversation: string, call: AgentCallResult & { input: unknown }) => void
const listeners = new Set<CallListener>()

/** The calls a device agent made through the MCP server, as they happen. */
export function onAgentCall(cb: CallListener): () => void {
	listeners.add(cb)
	return () => { listeners.delete(cb) }
}

export function startAgentBridge(): () => void {
	const bridge = platform.agentBridge
	if (!bridge) return () => {}
	return bridge.onRequest(request => {
		void (async () => {
			try {
				if (request.op === 'tools') {
					bridge.respond(request.rid, await agentTools(request.caller))
					return
				}
				const result = await agentCall(request.caller, request.conversation, String(request.name), request.input ?? {})
				bridge.respond(request.rid, result)
				for (const l of listeners) l(request.conversation, { ...result, input: request.input ?? {} })
			}
			catch (err) {
				bridge.respond(request.rid, null, err instanceof Error ? err.message : String(err))
			}
		})()
	})
}
