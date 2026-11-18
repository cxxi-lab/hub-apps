import { localEngine } from './engine'
import { modelFiles, modelPlans } from './models'

/**
 * `ai.chat` (client docs/plan-ia-moteur.md § 6): a hubby talks to one of the models it declares
 * (its hubby.json "ai", the checked copy), on this device only. The app has checked its scope
 * (`app:ai`, HubbyHost); here: the model is one it declares, the user agreed to it on this device
 * and it is here (else `consent` / `missing`: the app asks, downloads, calls again), the request is
 * sane, the engine runs it; the answer streams (`delta`), tool calls gathered at the end.
 */

export interface ChatMessage {
	role: 'system' | 'user' | 'assistant' | 'tool'
	content: string
	/** an assistant's tool calls, as it made them (sent back with their results) */
	tool_calls?: Array<{ id: string, type: 'function', function: { name: string, arguments: string } }>
	/** a tool message: the call it answers */
	tool_call_id?: string
}

export interface ChatTool { type: 'function', function: { name: string, description?: string, parameters?: Record<string, unknown> } }

export interface ChatRequest {
	/** a model the hubby declares (its hubby.json "ai", by name) */
	model: string
	messages: ChatMessage[]
	tools?: ChatTool[]
	temperature?: number
	maxTokens?: number
	/** let a reasoning model think first (its thoughts come as `reasoning`); default false */
	reasoning?: boolean
}

export interface ToolCall { id: string, name: string, arguments: unknown, error?: string }

export interface ChatResult {
	content: string
	toolCalls: ToolCall[]
	finishReason: string | null
	usage: { promptTokens: number, completionTokens: number } | null
}

export type ChatOutcome =
	| { ok: true, result: ChatResult }
	| { ok: false, code: 'consent' | 'missing' | 'unavailable' | 'invalid' | 'failed', message: string }

const NAME = /^[a-z][a-z0-9-]{0,39}$/
const ROLES = new Set(['system', 'user', 'assistant', 'tool'])
const MAX_MESSAGES = 400
const MAX_CHARS = 400_000
const MAX_TOOLS = 64
const MAX_TOKENS = 8_192

function invalid(message: string): ChatOutcome {
	return { ok: false, code: 'invalid', message }
}

/** The request as the engine gets it (only what it should see), or why not. */
function checked(request: unknown): { body: Record<string, unknown>, model: string } | ChatOutcome {
	const r = request as Partial<ChatRequest> | null
	if (!r || typeof r !== 'object' || typeof r.model !== 'string' || !NAME.test(r.model)) return invalid('model: a model it declares, by name')
	if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > MAX_MESSAGES) return invalid(`messages: 1 to ${MAX_MESSAGES}`)
	let chars = 0
	const messages = []
	for (const m of r.messages) {
		if (!m || !ROLES.has(m.role) || typeof m.content !== 'string') return invalid('a message is { role: system|user|assistant|tool, content: string }')
		chars += m.content.length
		const out: Record<string, unknown> = { role: m.role, content: m.content }
		if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
			out.tool_calls = m.tool_calls.map(c => ({ id: String(c?.id ?? ''), type: 'function', function: { name: String(c?.function?.name ?? ''), arguments: String(c?.function?.arguments ?? '{}') } }))
		}
		if (m.role === 'tool') {
			if (typeof m.tool_call_id !== 'string') return invalid('a tool message names the call it answers (tool_call_id)')
			out.tool_call_id = m.tool_call_id
		}
		messages.push(out)
	}
	if (chars > MAX_CHARS) return invalid(`messages: at most ${MAX_CHARS} characters`)
	const body: Record<string, unknown> = {
		messages,
		stream: true,
		stream_options: { include_usage: true },
		max_tokens: Math.min(Number.isInteger(r.maxTokens) && r.maxTokens! > 0 ? r.maxTokens! : 1_024, MAX_TOKENS),
		chat_template_kwargs: { enable_thinking: r.reasoning === true }
	}
	if (typeof r.temperature === 'number' && r.temperature >= 0 && r.temperature <= 2) body.temperature = r.temperature
	if (r.tools !== undefined) {
		if (!Array.isArray(r.tools) || r.tools.length > MAX_TOOLS) return invalid(`tools: at most ${MAX_TOOLS}`)
		for (const t of r.tools) {
			if (t?.type !== 'function' || typeof t.function?.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.function.name)) return invalid('a tool is { type: function, function: { name, description?, parameters? } }')
		}
		if (r.tools.length) body.tools = r.tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description ?? '', parameters: t.function.parameters ?? { type: 'object', properties: {} } } }))
	}
	return { body, model: r.model }
}

// the engine runs one model at a time: a switch waits for the answers under way
let inFlight = 0
let idle: Array<() => void> = []
const settled = () => new Promise<void>(resolve => inFlight === 0 ? resolve() : idle.push(resolve))

/** One chat; `onEvent` hears the answer as it comes ('delta': text, 'reasoning': its thoughts). */
export async function chat(hubby: string, request: unknown, onEvent: (kind: 'delta' | 'reasoning', text: string) => void, signal: AbortSignal): Promise<ChatOutcome> {
	const req = checked(request)
	if ('ok' in req) return req
	if (!localEngine.available()) return { ok: false, code: 'unavailable', message: 'the AI engine is not available on this device' }
	const plan = (await modelPlans()).find(p => p.hubby === hubby && p.name === req.model)
	if (!plan || plan.invalid) return invalid(`${hubby} declares no model ${req.model} this device accepts`)
	if (plan.chosen === null) return { ok: false, code: 'unavailable', message: `${req.model} is too large for this device` }
	if (!plan.consented) return { ok: false, code: 'consent', message: `${req.model} is not allowed on this device yet` }
	const files = modelFiles(hubby, req.model)
	if (!files) return { ok: false, code: 'missing', message: `${req.model} is not downloaded yet` }
	if (plan.family !== 'text') return invalid(`${req.model} is not a text model`)

	if (localEngine.getInfo().model !== files[0]) await settled()
	inFlight++
	try {
		await localEngine.text(files[0])
		const res = await localEngine.request('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body), signal })
		if (!res.ok || !res.body) return { ok: false, code: 'failed', message: `the engine answered ${res.status}: ${(await res.text()).slice(0, 300)}` }
		return { ok: true, result: await readStream(res.body, onEvent) }
	}
	catch (err) {
		if (signal.aborted) return { ok: false, code: 'failed', message: 'aborted' }
		return { ok: false, code: 'failed', message: err instanceof Error ? err.message : String(err) }
	}
	finally {
		inFlight--
		if (inFlight === 0) { const waiting = idle; idle = []; waiting.forEach(w => w()) }
	}
}

interface Chunk {
	choices?: Array<{ delta?: { content?: string | null, reasoning_content?: string | null, tool_calls?: Array<{ index: number, id?: string, function?: { name?: string, arguments?: string } }> }, finish_reason?: string | null }>
	usage?: { prompt_tokens: number, completion_tokens: number }
}

/** The engine's server-sent events, gathered (the text streamed as it comes, the tool calls at the end). */
async function readStream(body: ReadableStream<Uint8Array>, onEvent: (kind: 'delta' | 'reasoning', text: string) => void): Promise<ChatResult> {
	const reader = body.getReader()
	const decoder = new TextDecoder()
	let buffer = ''
	let content = ''
	let finishReason: string | null = null
	let usage: ChatResult['usage'] = null
	const calls = new Map<number, { id: string, name: string, args: string }>()
	// the engine may keep the connection open after its last event: [DONE] ends the answer
	let finished = false
	while (!finished) {
		const { done, value } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		let at: number
		while ((at = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, at).trim()
			buffer = buffer.slice(at + 1)
			if (!line.startsWith('data:')) continue
			const data = line.slice(5).trim()
			if (data === '[DONE]') { finished = true; break }
			let chunk: Chunk
			try { chunk = JSON.parse(data) as Chunk }
			catch { continue }
			if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens, completionTokens: chunk.usage.completion_tokens }
			for (const choice of chunk.choices ?? []) {
				const d = choice.delta
				if (d?.content) { content += d.content; onEvent('delta', d.content) }
				if (d?.reasoning_content) onEvent('reasoning', d.reasoning_content)
				for (const t of d?.tool_calls ?? []) {
					const call = calls.get(t.index) ?? { id: '', name: '', args: '' }
					if (t.id) call.id = t.id
					if (t.function?.name) call.name += t.function.name
					if (t.function?.arguments) call.args += t.function.arguments
					calls.set(t.index, call)
				}
				if (choice.finish_reason) finishReason = choice.finish_reason
			}
		}
	}
	if (finished) void reader.cancel().catch(() => {})
	const toolCalls: ToolCall[] = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => {
		try { return { id: c.id, name: c.name, arguments: c.args ? JSON.parse(c.args) as unknown : {} } }
		catch { return { id: c.id, name: c.name, arguments: c.args, error: 'its arguments are not valid JSON' } }
	})
	return { content, toolCalls, finishReason, usage }
}
