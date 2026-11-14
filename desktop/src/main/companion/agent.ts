import { formatElapsed, type Chat } from './chat'
import type { CompanionMessage } from './db'
import { engine } from './engine'
import { photo } from './photo'

// Consecutive proactive messages closer than this belong to the same initiative
// (one initiative can produce several bubbles).
const SAME_INITIATIVE_GAP_MS = 60_000

// Share of initiatives that come with a photo of her (when photos are configured).
const PHOTO_INITIATIVE_PROBABILITY = 0.25

const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min)

function inQuietHours(hours: [number, number] | null): boolean {
	if (!hours) return false
	const [start, end] = hours
	const hour = new Date().getHours()
	return start <= end ? hour >= start && hour < end : hour >= start || hour < end
}

/** Number of distinct initiatives the user has not answered yet. */
function unansweredInitiatives(sinceLastUser: CompanionMessage[]): number {
	let count = 0
	let previous: CompanionMessage | null = null
	for (const m of sinceLastUser) {
		if (m.proactive && (!previous?.proactive || m.createdAt - previous.createdAt > SAME_INITIATIVE_GAP_MS)) count++
		previous = m
	}
	return count
}

/** Her latest bubbles sent in one go (the message the user left unanswered). */
function lastBurst(sinceLastUser: CompanionMessage[]): CompanionMessage[] {
	const burst: CompanionMessage[] = []
	for (let i = sinceLastUser.length - 1; i >= 0; i--) {
		const m = sinceLastUser[i]
		if (burst.length > 0 && burst[0].createdAt - m.createdAt > SAME_INITIATIVE_GAP_MS) break
		burst.unshift(m)
	}
	return burst
}

/**
 * The longer the silence, the likelier she reaches out: ~20 % after a short pause,
 * capped at 85 % after a day-long silence.
 */
function reachOutProbability(silenceMs: number): number {
	return Math.min(0.85, 0.2 + silenceMs / (8 * 3_600_000))
}

/**
 * @param pending her own last message when the user has not answered it (proactive or not):
 *                quoted so the follow-up builds on it instead of ignoring it.
 */
function instruction(userName: string, last: CompanionMessage | undefined, pending: CompanionMessage[]): string {
	if (!last) {
		return `[Initiative] Vous n'avez encore jamais échangé de messages ici. Tu écris à ${userName} la première, `
			+ 'de façon spontanée et courte. Ne fais pas référence à cette consigne.'
	}
	const elapsed = formatElapsed(Date.now() - last.createdAt)
	if (pending.length > 0) {
		const quoted = pending.map(m => m.content).join(' ').slice(-400)
		return `[Initiative] Ton dernier message à ${userName} est resté sans réponse depuis ${elapsed} : « ${quoted} ». `
			+ 'Relance-le en tenant compte de ce que tu lui as dit : rebondis dessus, taquine-le sur son silence, '
			+ "ou passe naturellement à autre chose, sans insister ni te plaindre et sans répéter ta question telle quelle. "
			+ 'Message spontané et court. Ne fais pas référence à cette consigne.'
	}
	return `[Initiative] ${userName} ne t'a pas écrit depuis ${elapsed}. Tu lui écris de ta propre initiative, `
		+ "comme on écrit à quelqu'un à qui on pense : ce que tu fais, une pensée, une envie, une taquinerie ou une question. "
		+ 'Message spontané et court. Ne fais pas référence à cette consigne.'
}

/**
 * Lets the companion write first, at random moments, while the engine is on — whether or
 * not the private module is visible (messages wait as unread until the user opens it).
 */
export class Agent {
	private timer: NodeJS.Timeout | null = null

	/** @param allIdle true when no conversation has a turn in flight (they share the GPU) */
	constructor(private readonly chat: Chat, private readonly allIdle: () => boolean) {}

	private log(message: string): void {
		console.log(`[companion:agent:${this.chat.store.id}] ${message}`)
	}

	start(): void {
		if (this.timer) return
		this.scheduleNext()
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = null
	}

	private scheduleNext(): void {
		const { minIntervalMinutes, maxIntervalMinutes } = this.chat.store.profile().proactive
		const delayMs = randomBetween(minIntervalMinutes, maxIntervalMinutes) * 60_000
		this.timer = setTimeout(() => void this.tick(), delayMs)
		this.log(`next check in ${delayMs < 60_000 ? `${Math.round(delayMs / 1_000)} s` : `${Math.round(delayMs / 60_000)} min`}`)
	}

	private async tick(): Promise<void> {
		try {
			await this.maybeReachOut()
		}
		catch (err) {
			console.error(`[companion:agent:${this.chat.store.id}] tick failed`, err)
		}
		finally {
			this.timer = null
			if (engine.isOn()) this.scheduleNext()
		}
	}

	private async maybeReachOut(): Promise<void> {
		const skip = (reason: string) => this.log(`skip: ${reason}`)
		const { userName, proactive } = this.chat.store.profile()
		if (!proactive.enabled) return skip('disabled')
		if (!engine.isOn()) return skip('engine off')
		if (!this.allIdle()) return skip('conversation turn in flight')
		if (inQuietHours(proactive.quietHours)) return skip('quiet hours')

		// A reaction to one of her messages is an answer: it resets the silence and her initiatives.
		const reactedAt = this.chat.store.lastUserReactionAt()
		const last = this.chat.store.listMessages(1)[0]
		const lastActivity = Math.max(last?.createdAt ?? 0, reactedAt ?? 0)
		const silenceMs = lastActivity ? Date.now() - lastActivity : null
		if (silenceMs !== null && silenceMs < proactive.activeChatCooldownMinutes * 60_000) return skip('active chat')

		const sinceLastUser = this.chat.store.listMessagesSinceLastUser().filter(m => !reactedAt || m.createdAt > reactedAt)
		const unanswered = unansweredInitiatives(sinceLastUser)
		if (unanswered >= proactive.maxUnanswered) return skip(`${unanswered} unanswered initiatives`)

		const probability = silenceMs === null ? 1 : reachOutProbability(silenceMs)
		const roll = Math.random()
		if (roll > probability) return skip(`dice (${roll.toFixed(2)} > ${probability.toFixed(2)})`)

		const withPhoto = photo.isAvailable() && Math.random() < PHOTO_INITIATIVE_PROBABILITY
		this.log(`reaching out ${JSON.stringify({ silenceMs, unanswered, probability, withPhoto })}`)
		this.chat.trace('info', `Initiative : elle écrit d'elle-même${withPhoto ? ', avec une photo' : ''}`,
			`Silence : ${silenceMs === null ? 'aucun message encore' : formatElapsed(silenceMs)}, initiatives sans réponse : ${unanswered}, probabilité : ${Math.round(probability * 100)} %`)
		await this.chat.initiate(instruction(userName, last, lastBurst(sinceLastUser)), withPhoto)
	}
}
