import { fetchSettings, updateSettings } from '@core/api/settings'
import { allApis, callHubby, isAvailable, type ApiMethod } from '@core/hubby/apis'
import { HUBBY_MANIFESTS } from '@core/hubby/registry'
import { askAgentConfirmation } from './AgentConfirm'

/**
 * An AI assistant acting on the user's hubbies (client docs/plan-ia-agent.md, phase 1): its tools are
 * the hubbies' APIs (api.json, api.md), of the hubbies the user opened to it only (D2: the account's
 * setting assistant.hubbies, synced) that may answer now (active, shown, unlocked). Calling one:
 * `read` runs; `write` asks the user first (or not, if allowed for the whole conversation); `outward`
 * (outside Hubbyware, for good) always asks (D3: Hubbyware confirms, whatever the engine). Every call
 * returns what its trace needs.
 */

export interface AgentTool {
	/** its name for an engine (hubby__method, [A-Za-z0-9_-]) */
	name: string
	hubby: string
	hubbyLabel: string
	method: string
	description: string
	input: unknown
	effect: ApiMethod['effect']
}

export interface AgentCallResult {
	tool: string
	hubby: string
	method: string
	effect: ApiMethod['effect']
	/** asked to the user, and what they said */
	confirmation: 'none' | 'allowed' | 'allowed-for-conversation' | 'denied'
	ok: boolean
	result?: unknown
	error?: string
}

const labelOf = (hubby: string) => HUBBY_MANIFESTS.find(m => m.id === hubby)?.label ?? hubby
const toolName = (hubby: string, method: string) => `${hubby}__${method}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)

// --- the hubbies opened to the assistant (the account's setting, synced) ---

let opened: string[] | null = null
const ID = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/

export async function assistantHubbies(): Promise<string[]> {
	if (opened) return opened
	const { hubbies } = await fetchSettings<{ hubbies: string }>('assistant')
	opened = (hubbies ?? '').split(',').filter(id => ID.test(id))
	return opened
}

export async function setAssistantHubbies(ids: string[]): Promise<string[]> {
	const clean = [...new Set(ids.filter(id => ID.test(id)))]
	await updateSettings('assistant', { hubbies: clean.join(',') })
	opened = clean
	return clean
}

/** Every hubby with an API (whether it is opened or not): what the user may open. */
export function hubbiesWithApis(): Array<{ hubby: string, label: string, methods: number, writes: boolean, outward: boolean }> {
	return allApis().filter(a => isAvailable(a.hubby)).map(a => {
		const methods = Object.values(a.methods)
		return { hubby: a.hubby, label: labelOf(a.hubby), methods: methods.length, writes: methods.some(m => m.effect === 'write'), outward: methods.some(m => m.effect === 'outward') }
	})
}

/** The assistant's tools: the methods of the hubbies opened to it that may answer now; and their api.md. */
export async function agentTools(exclude?: string): Promise<{ tools: AgentTool[], docs: Array<{ hubby: string, label: string, doc: string }> }> {
	const open = new Set(await assistantHubbies())
	const apis = allApis().filter(a => open.has(a.hubby) && a.hubby !== exclude && isAvailable(a.hubby))
	return {
		tools: apis.flatMap(a => Object.entries(a.methods).map(([method, m]) => ({
			name: toolName(a.hubby, method), hubby: a.hubby, hubbyLabel: labelOf(a.hubby), method,
			description: m.description, input: m.input, effect: m.effect
		}))),
		docs: apis.filter(a => a.doc).map(a => ({ hubby: a.hubby, label: labelOf(a.hubby), doc: a.doc! }))
	}
}

// the methods allowed for a whole conversation (write only; never outward), for this session
const allowedIn = new Map<string, Set<string>>()

/** One call of the assistant, for `caller` (the hubby running it) in `conversation`. */
export async function agentCall(caller: string, conversation: string, name: string, input: unknown): Promise<AgentCallResult> {
	const { tools } = await agentTools(caller)
	const tool = tools.find(t => t.name === name)
	if (!tool) return { tool: name, hubby: '', method: '', effect: 'read', confirmation: 'none', ok: false, error: `no tool ${name} (its hubby isn't opened to the assistant, or can't answer now)` }
	const base = { tool: name, hubby: tool.hubby, method: tool.method, effect: tool.effect }
	let confirmation: AgentCallResult['confirmation'] = 'none'
	if (tool.effect !== 'read') {
		const already = tool.effect === 'write' && allowedIn.get(conversation)?.has(name)
		if (already) confirmation = 'allowed-for-conversation'
		else {
			const answer = await askAgentConfirmation(tool, input)
			if (answer === 'deny') return { ...base, confirmation: 'denied', ok: false, error: 'the user did not allow it' }
			if (answer === 'always' && tool.effect === 'write') {
				const set = allowedIn.get(conversation) ?? new Set()
				set.add(name)
				allowedIn.set(conversation, set)
				confirmation = 'allowed-for-conversation'
			}
			else confirmation = 'allowed'
		}
	}
	try {
		return { ...base, confirmation, ok: true, result: await callHubby(caller, tool.hubby, tool.method, input) }
	}
	catch (err) {
		return { ...base, confirmation, ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}
