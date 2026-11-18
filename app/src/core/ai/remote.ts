import { platform, type AgentRunRequest, type AgentRunResult } from '@platform'
import { api } from '@core/api/client'
import { requireDataKeys } from '@core/crypto/dataKey'
import { open, seal } from '@core/crypto/format'
import { describe } from '@core/devices/DevicesList'
import { session } from '@core/hubby/tokens'
import { onRelayEvent } from '@core/notifications/notifications'
import { askAgentConfirmation, type AgentAnswer } from './AgentConfirm'
import { setConversationConfirmer, type AgentCallResult, type AgentTool } from './agent'
import { onAgentCall } from './agentBridge'

/**
 * The remote engine (client docs/plan-ia-agent.md, phase 5): a device asks another of the account's
 * devices — one that is up, the app open — to run a turn on an engine it has (Claude Code). Each
 * device announces itself and its engines (PUT /api/hub/presence, every ~30 s); the turn, its text
 * as it comes, the calls it made, the go-aheads it needs (asked on the device asking: the user is
 * there) go through the server's relay (POST /api/hub/relay, the account's real-time topic), sealed
 * with the account's data key — the server relays them without reading. The device asking saves the
 * answer (as it does a turn run on itself).
 */

export interface RemoteDevice {
	id: string
	label: string
	detail: string | null
	online: boolean
	seenAt: string | null
	current: boolean
	engines: Array<{ id: string, label: string }>
}

type Message =
	| { t: 'run', rid: string, caller: string, req: AgentRunRequest }
	| { t: 'abort', rid: string }
	| { t: 'confirmed', rid: string, cid: string, answer: AgentAnswer }
	| { t: 'event', rid: string, kind: string, text: string }
	| { t: 'call', rid: string, call: AgentCallResult & { input: unknown } }
	| { t: 'confirm', rid: string, cid: string, tool: AgentTool, input: unknown }
	| { t: 'done', rid: string, result: AgentRunResult }
	| { t: 'error', rid: string, message: string }

/** each message once, and only fresh: a replayed one (by the server, a reconnection) is dropped */
type Sealed = Message & { mid: string, at: number }
const FRESH_MS = 2 * 60_000
const seen = new Map<string, number>()
function fresh(m: Sealed): boolean {
	const now = Date.now()
	if (typeof m.mid !== 'string' || typeof m.at !== 'number' || Math.abs(now - m.at) > FRESH_MS || seen.has(m.mid)) return false
	seen.set(m.mid, now)
	for (const [id, at] of seen) if (now - at > FRESH_MS) seen.delete(id)
	return true
}

const PRESENCE_MS = 30_000
/** the device asked says nothing this long: it isn't there */
const FIRST_ANSWER_MS = 20_000
/** a turn says nothing this long (no go-ahead pending): given up */
const SILENCE_MS = 5 * 60_000

let me: string | null = null
const mine = async () => me ??= await session()

const where = (from: string, to: string) => `relay/${from}/${to}`

async function post(to: string, message: Message): Promise<void> {
	const from = await mine()
	if (!from) throw new Error('not signed in')
	const { fields } = await requireDataKeys()
	const sealed: Sealed = { ...message, mid: crypto.randomUUID(), at: Date.now() }
	await api('/api/hub/relay', { method: 'POST', body: JSON.stringify({ to, sealed: seal(fields, where(from, to), JSON.stringify(sealed)) }) })
}

const handlers = new Set<(from: string, message: Message) => void>()
let listening: (() => void) | null = null

function listen(): void {
	if (listening) return
	listening = onRelayEvent(event => {
		void (async () => {
			if (event.to !== await mine()) return
			const { fields } = await requireDataKeys()
			let message: Sealed
			// sealed by one of the account's devices, for this one (else: not ours, dropped); once, fresh
			try { message = JSON.parse(open(fields, where(event.from, event.to), event.sealed)) as Sealed }
			catch { return }
			if (!fresh(message)) return
			for (const h of handlers) h(event.from, message)
		})()
	})
}

// --- the devices and their engines ---

async function offered(): Promise<Array<{ id: string, label: string }>> {
	const engines = await platform.agentBridge?.engines().catch(() => []) ?? []
	return engines.filter(e => e.available && e.signedIn !== false).map(e => ({ id: e.id, label: e.label }))
}

/** This device announces itself while the app runs; it runs the turns the account's other devices ask it. */
export function startRemote(): () => void {
	listen()
	let stopped = false
	const announce = async () => {
		if (stopped) return
		try { await api('/api/hub/presence', { method: 'PUT', body: JSON.stringify({ engines: await offered() }) }) }
		catch { /* offline: the next round */ }
	}
	void announce()
	const timer = setInterval(() => void announce(), PRESENCE_MS)
	const leave = () => { void api('/api/hub/presence', { method: 'DELETE', keepalive: true }).catch(() => {}) }
	window.addEventListener('pagehide', leave)
	const offRuns = serveRuns()
	return () => {
		stopped = true
		clearInterval(timer)
		window.removeEventListener('pagehide', leave)
		offRuns()
		leave()
	}
}

/** The account's devices (this one too: `current`), up or not, and the engines each offers. */
export async function remoteDevices(): Promise<RemoteDevice[]> {
	const { data } = await api<{ data: Array<{ id: string, client: string | null, userAgent: string | null, online: boolean, seenAt: string | null, current: boolean, engines: Array<{ id: string, label: string }> }> }>('/api/hub/presence')
	return data.map(d => {
		const { name, detail } = describe({ client: d.client, userAgent: d.userAgent })
		return { id: d.id, label: name, detail, online: d.online, seenAt: d.seenAt, current: d.current, engines: d.engines }
	})
}

export const thisDevice = mine

// --- a turn run here for another device ---

function serveRuns(): () => void {
	const bridge = platform.agentBridge
	if (!bridge) return () => {}
	const running = new Map<string, number>()
	const confirming = new Map<string, (answer: AgentAnswer) => void>()
	let nextRun = 1_000_000
	const handler = (from: string, m: Message) => {
		if (m.t === 'abort') { const id = running.get(m.rid); if (id) bridge.abort(id) }
		else if (m.t === 'confirmed') { confirming.get(`${m.rid}/${m.cid}`)?.(m.answer); confirming.delete(`${m.rid}/${m.cid}`) }
		else if (m.t === 'run') void run(from, m)
	}
	const run = async (from: string, m: Extract<Message, { t: 'run' }>) => {
		const { rid, caller, req } = m
		const runId = nextRun++
		running.set(rid, runId)
		const send = (message: Message) => post(from, message).catch(() => {})
		// the text in batches (one message every ~200 ms, not one a token)
		let pending = ''
		let flush: ReturnType<typeof setTimeout> | null = null
		const flushNow = () => { if (flush) clearTimeout(flush); flush = null; if (pending) { void send({ t: 'event', rid, kind: 'delta', text: pending }); pending = '' } }
		const off = bridge.onEvent(e => {
			if (e.id !== runId) return
			if (e.kind === 'delta') { pending += e.text; flush ??= setTimeout(flushNow, 200) }
			else { flushNow(); void send({ t: 'event', rid, kind: e.kind, text: e.text }) }
		})
		const offCalls = onAgentCall((conversation, call) => { if (conversation === req.conversation) { flushNow(); void send({ t: 'call', rid, call }) } })
		let cid = 0
		// its go-aheads: asked on the device that asked for the turn
		setConversationConfirmer(req.conversation, (tool, input) => new Promise<AgentAnswer>(resolve => {
			const id = String(++cid)
			confirming.set(`${rid}/${id}`, resolve)
			flushNow()
			void send({ t: 'confirm', rid, cid: id, tool, input })
		}))
		try {
			await send({ t: 'event', rid, kind: 'status', text: 'started' })
			const result = await bridge.run(runId, caller, { engine: req.engine, conversation: req.conversation, text: req.text, transcript: req.transcript ?? null, instructions: req.instructions ?? null })
			flushNow()
			await send({ t: 'done', rid, result })
		}
		catch (err) {
			flushNow()
			await send({ t: 'error', rid, message: err instanceof Error ? err.message : String(err) })
		}
		finally {
			off()
			offCalls()
			setConversationConfirmer(req.conversation, null)
			for (const key of [...confirming.keys()]) if (key.startsWith(`${rid}/`)) { confirming.get(key)?.('deny'); confirming.delete(key) }
			running.delete(rid)
		}
	}
	handlers.add(handler)
	return () => { handlers.delete(handler) }
}

// --- a turn asked to another device ---

export interface RemoteRunEvents {
	onEvent: (kind: string, text: string) => void
	onCall: (call: AgentCallResult & { input: unknown }) => void
	signal: AbortSignal
}

/** A turn on `device`'s engine: its events as they come; its result, or why it failed. */
export function remoteRun(device: string, caller: string, req: AgentRunRequest, events: RemoteRunEvents): Promise<AgentRunResult> {
	listen()
	const rid = crypto.randomUUID()
	return new Promise<AgentRunResult>((resolve, reject) => {
		let heard = false
		let asking = 0
		let timer: ReturnType<typeof setTimeout> | null = null
		const quiet = () => {
			if (timer) clearTimeout(timer)
			timer = asking ? null : setTimeout(() => finish(new Error(heard ? 'the other device stopped answering' : 'the other device did not answer (is the app open there?)')), heard ? SILENCE_MS : FIRST_ANSWER_MS)
		}
		const finish = (outcome: AgentRunResult | Error) => {
			if (timer) clearTimeout(timer)
			handlers.delete(handler)
			events.signal.removeEventListener('abort', abort)
			if (outcome instanceof Error) reject(outcome)
			else resolve(outcome)
		}
		const handler = (from: string, m: Message) => {
			if (from !== device || !('rid' in m) || m.rid !== rid) return
			heard = true
			if (m.t === 'event') events.onEvent(m.kind, m.text)
			else if (m.t === 'call') events.onCall(m.call)
			else if (m.t === 'confirm') {
				asking++
				void askAgentConfirmation(m.tool, m.input).then(answer => {
					asking--
					quiet()
					return post(device, { t: 'confirmed', rid, cid: m.cid, answer })
				}).catch(() => {})
			}
			else if (m.t === 'done') return finish(m.result)
			else if (m.t === 'error') return finish(new Error(m.message))
			quiet()
		}
		const abort = () => { void post(device, { t: 'abort', rid }).catch(() => {}) }
		handlers.add(handler)
		events.signal.addEventListener('abort', abort)
		quiet()
		post(device, { t: 'run', rid, caller, req: { engine: req.engine, conversation: req.conversation, text: req.text, transcript: req.transcript ?? null, instructions: req.instructions ?? null } })
			.catch(err => finish(err instanceof Error ? err : new Error(String(err))))
	})
}
