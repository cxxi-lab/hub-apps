import { EventEmitter } from 'node:events'

import {
	type CompanionMessage, type ConversationStore, type ExtraLora, type PhotoSettings, type RelationshipStage, type Reminder
} from './db'
import { engine, OLLAMA_URL } from './engine'
import { feminize } from './gender'
import { waitForCoolGpu } from './gpu'
import { photo, type PhotoResult } from './photo'
import { conversationLevel, type ConversationLevel } from './mood'
import {
	expectedTags, maxLevel, minLevel, ownPhotoLevel, photoDecision, photoLevelOf, showsOwnRearView, shownByTags, wantsFullBody, wantsRearView, type PhotoDecision, type PhotoLevel
} from './photo-policy'
import { toSpokenFrench } from './spoken'
import { voice, type VoiceRegister } from './voice'
import { voiceRegisterFor, voiceRequested } from './voice-policy'

/** What the companion is doing right now, shown in the conversation header. */
export type CompanionActivity = 'typing' | 'recording' | 'photo' | null

// Replies wait for the user to finish typing a burst of messages, like a person reading
// everything before answering.
const REPLY_DEBOUNCE_MS = 1_500
// The memory summary takes minutes on a hot GPU: it waits for a quiet moment instead of
// holding up his next message.
const SUMMARY_IDLE_MS = 3 * 60_000
// Pause between the bubbles of a multi-paragraph reply.
const BUBBLE_GAP_MS = 900
const MAX_BUBBLES = 2
// Testing shortcut: a message starting with "/normal", "/soft" or "/hard" gets a photo of that
// level, whatever the mood, the hour or the stage. The prefix is not kept in the message.
const FORCED_PHOTO = /^\/(normal|soft|hard)\s+/i
// In a fantasy she jumps to the climax despite the pacing note: such a reply is written again
// once, unless he got there first.
const CLIMAX = /(?<![\p{L}])(?:orgasmes?|jouir|jouis|jouit|jouissance|apogée|explos(?:er|e|ions?) de plaisir)(?![\p{L}])/iu
const CLIMAX_RETRY_NOTE = '[Note] Ta réponse précédente allait jusqu\'à l\'orgasme : beaucoup trop tôt. Reste sur ce moment, '
	+ 'un seul geste ou une sensation, et laisse-le répondre. Ne fais pas référence à cette note.'
// Shorter sentences ("Oui !", "Mdr") may legitimately repeat.
const MIN_DEDUP_SENTENCE_LENGTH = 25
// Rough budget for the conversation window sent to the model (persona and output excluded),
// sized for a 6k-token context. Older messages are folded into the memory summary.
const HISTORY_CHAR_BUDGET = 12_000
const GENERATION_TIMEOUT_MS = 180_000

// Closing note when the user asked for a voice message, so she speaks instead of describing.
const VOICE_REQUEST_NOTE = '[Note] Ta réponse lui sera envoyée en message vocal : écris uniquement ce que tu lui dis '
	+ 'à voix haute, sans actions entre astérisques. Ne fais pas référence à cette note.'
// When he asked to see her: the photo has just gone out, her message comes right after it and must
// match what it really shows (`shown`: the tagger's keywords, or the scene asked for without tagger).
const photoNote = (shown: string): string => '[Note] Tu viens de lui envoyer une photo de toi, celle qu\'il t\'a demandée. '
	+ `Elle montre (mots-clés) : ${shown}. Écris seulement le petit message qui l'accompagne, `
	+ 'court et naturel, cohérent avec ce que montre cette photo, sans la décrire en détail. Ne fais pas référence à cette note.'
// A photo more daring than the moment allows.
const TEASE_NOTE = '[Note] Il te demande une photo de toi plus osée que ce que le moment permet encore : tu refuses '
	+ 'en le taquinant et en te faisant désirer, sans le rejeter, et tu n\'envoies rien. Ne fais pas référence à cette note.'
// When she reaches out with a photo of her own accord.
const photoInitiativeNote = (shown: string): string => '[Note] Tu viens de lui envoyer une photo de toi, prise à l\'instant. '
	+ `Elle montre (mots-clés) : ${shown}. Écris seulement le petit message qui l'accompagne, cohérent avec elle, sans la décrire.`
// How charged the exchange is, given before her reply so her tone follows. Flirting needs no
// note (the conversation carries it): every extra line confuses a small model. In a fantasy
// she rushed to the climax in one message: the pacing is spelled out.
const LEVEL_NOTE: Record<ConversationLevel, string | null> = {
	normal: null,
	seduction: null,
	fantasy: '[Ambiance] La conversation est chaude, vous fantasmez ensemble : dans les limites de votre étape. '
		+ 'Un seul pas à la fois : tu réagis à son dernier geste, tu ajoutes un geste ou une sensation, puis tu le laisses '
		+ 'répondre. Vous faites durer : pas d\'orgasme ni de fin tant que la scène n\'en est pas vraiment là.'
}
// What the photo may show, for the scene model.
const LEVEL_SCENE: Record<PhotoLevel, string> = {
	normal: 'La photo est habillée, sans nudité ni lingerie.',
	soft: 'La photo est sexy : lingerie, sous-vêtements ou semi-nue, sans montrer ses tétons ni son sexe.',
	hard: 'La photo peut être explicite si la conversation le demande.'
}
const FALLBACK_SCENE: Record<PhotoLevel, string> = {
	normal: "arm's length selfie, high angle, close framing, casual outfit, at home, soft daylight, gentle smile",
	soft: "arm's length selfie, high angle, close framing, black lace lingerie, sitting on her bed, soft warm light, teasing smile",
	hard: "arm's length selfie, high angle, close framing, nude, lying on her bed, soft warm light, sensual look"
}
// Share of his messages she considers reacting to; the model still often picks none.
const REACTION_PROBABILITY = 0.5
// Emojis she may put on his messages; the heart only once past the first relationship stage.
const REACTIONS = ['😂', '😏', '🔥', '🥺', '😊', '😮']
const LOVE_REACTIONS = ['❤️', '😘']
// When he reacts to her latest message without writing, she may bounce off it after a short
// pause (unless he starts writing). Nearly always for a photo, sometimes for a text.
const REACTION_REPLY_DELAY_MS: [number, number] = [6_000, 15_000]
const REACTION_REPLY_PROBABILITY = { image: 0.9, other: 0.5 }
// Consecutive bounces on reactions before she waits for him to actually write.
const MAX_REACTION_REPLIES = 2
// Night hours for the relationship stages' night photo cap.
const NIGHT_START_HOUR = 22
const NIGHT_END_HOUR = 6
// Messages kept as the context of a reply in the feedback table.
const FEEDBACK_CONTEXT_MESSAGES = 12
// Messages scanned for the profile reminders' topics.
const REMINDER_CONTEXT_MESSAGES = 6
// Messages around a photo request used to read the mood and describe the scene.
const PHOTO_CONTEXT_MESSAGES = 8

interface OllamaMessage {
	role: 'system' | 'user' | 'assistant'
	content: string
}

/** One line of the conversation's activity log (shown in the app's side panel). */
export interface ActivityEntry {
	id: number
	at: number
	level: 'info' | 'warn' | 'error'
	text: string
	/** raw text behind the line (reply, notes, scene, tags…) */
	detail?: string
}

export type Trace = (level: ActivityEntry['level'], text: string, detail?: string) => void

const MAX_ACTIVITY_ENTRIES = 300
let nextActivityId = 1

interface ModelReply {
	content: string
	/** stopped by the length limit (num_predict) */
	cut: boolean
	tokens: number
	ms: number
	/** time spent waiting for the GPU to cool down first */
	cooledMs: number
}

async function ollamaChat(model: string, messages: OllamaMessage[], options?: Record<string, unknown>): Promise<ModelReply> {
	const cooledMs = await waitForCoolGpu()
	const started = Date.now()
	const res = await fetch(`${OLLAMA_URL}/api/chat`, {
		method: 'POST',
		body: JSON.stringify({ model, messages, stream: false, ...(options ? { options } : {}) }),
		signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS)
	})
	if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`)
	const data = await res.json() as { message: { content: string }; done_reason?: string; eval_count?: number }
	return { content: data.message.content.trim(), cut: data.done_reason === 'length', tokens: data.eval_count ?? 0, ms: Date.now() - started, cooledMs }
}

let gpuTail: Promise<void> = Promise.resolve()

/**
 * Conversations share one GPU: a turn (reply with its photo or voice, memory summary) waits
 * for the other conversations' to end. Resolves with the function that ends this turn.
 */
async function gpuTurn(): Promise<() => void> {
	let release!: () => void
	const previous = gpuTail
	gpuTail = new Promise(resolve => { release = resolve })
	await previous
	return release
}

export function formatElapsed(ms: number): string {
	const min = Math.round(ms / 60_000)
	if (min < 60) return `${min} min`
	const h = Math.round(min / 60)
	if (h < 48) return `${h} h`
	return `${Math.round(h / 24)} jours`
}

/** Splits the newest messages that fit the budget from the older ones to summarize. */
function splitWindow(messages: CompanionMessage[]): { older: CompanionMessage[]; window: CompanionMessage[] } {
	let used = 0
	let i = messages.length
	while (i > 0 && used + messages[i - 1].content.length <= HISTORY_CHAR_BUDGET) {
		used += messages[i - 1].content.length
		i--
	}
	return { older: messages.slice(0, i), window: messages.slice(i) }
}

function dayPeriod(hour: number): string {
	if (hour < 6) return 'en pleine nuit'
	if (hour < 12) return 'le matin'
	if (hour < 14) return 'le midi'
	if (hour < 18) return "l'après-midi"
	if (hour < 22) return 'le soir'
	return 'tard le soir'
}

const DAY_MS = 86_400_000

/** Where the relationship stands, from the conversation's age (see profile `relationship`). */
function currentStage(stages: RelationshipStage[], age: { startedAt: number | null; messages: number }): RelationshipStage | null {
	if (stages.length === 0) return null
	const { startedAt, messages } = age
	const days = startedAt ? (Date.now() - startedAt) / DAY_MS : 0
	return stages.find(s => days < (s.untilDays ?? Infinity) || messages < (s.untilMessages ?? Infinity)) ?? stages.at(-1)!
}

/**
 * Current date and time. Sent as the last note before her reply: a small model mostly
 * ignores what sits at the top of a long context.
 */
function contextNote(userName: string, lastExchangeAt: number | null): string {
	const now = new Date()
	const date = now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })
	const time = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
	const weekend = now.getDay() === 0 || now.getDay() === 6
	let note = `[Contexte] ${date} (${weekend ? 'week-end' : 'semaine'}), ${dayPeriod(now.getHours())}, ${time} pour vous deux (même fuseau).`
	if (lastExchangeAt && Date.now() - lastExchangeAt > 60 * 60_000) {
		note += ` Dernier échange avec ${userName} il y a ${formatElapsed(Date.now() - lastExchangeAt)}.`
	}
	return note
}

/**
 * Reactions he put on her messages since she last wrote, so she can take them into account.
 * Given in the closing note rather than inside the history: the model would start writing
 * such markers in its own replies.
 */
function reactionNote(window: CompanionMessage[], userName: string): string | null {
	const lastWritten = window.filter(m => m.role === 'companion').at(-1)?.createdAt ?? 0
	const reacted = window.filter(m => m.role === 'companion' && m.userReaction && (m.userReactionAt ?? 0) > lastWritten)
	if (reacted.length === 0) return null
	const items = reacted.slice(-3).map(m => `${m.userReaction} sur ton message « ${asText(m).slice(0, 120)} »`)
	return `[Réactions] ${userName} a réagi avec un emoji : ${items.join(' ; ')}. `
		+ 'Tiens-en compte naturellement (ton, humeur), sans forcément le commenter.'
}

const REAR_VIEW = { scene: '(rear view, from behind, back to the camera:1.3)', negative: '(front view, facing the camera, three-quarter view:1.2)' }
// A message sent with a photo must not refuse it (her earlier refusals pull her that way).
const REFUSAL = /je ne peux pas|je ne vais pas|hors de question|désolée|des limites|pas à l'aise|on se conna[iî]t à peine/i
const REFUSAL_RETRY_NOTE = '[Note] Tu envoies bien cette photo, de ton plein gré : ton message l\'assume, sans refuser ni t\'excuser.'
const FULL_BODY_FRAMING = 'mirror selfie, (full body, head to toe:1.2), standing in front of a large mirror'
// Framing words the scene model may still write; replaced when the framing is imposed.
const FRAMING_TERMS = /\b(arm's length selfie|mirror selfie|selfie|high angle|low angle|close[- ]up|close framing|tight framing|phone propped up nearby|full body|full-length|head to toe|standing in front of a (?:large )?mirror)\b(?:\s*\([\d.]+\))?,?\s*/gi

/** Imposes the full-length mirror framing, whatever the scene model chose. */
function withFullBodyFraming(scene: string): string {
	const rest = scene.replace(FRAMING_TERMS, '').replace(/^[\s,]+|[\s,]+$/g, '')
	return rest ? `${FULL_BODY_FRAMING}, ${rest}` : FULL_BODY_FRAMING
}

/**
 * Puts the outfit hints right after the framing: words early in the prompt weigh more,
 * and the image model tends to drop the ones at the end.
 */
function withOutfitHints(scene: string, hints: string[]): string {
	if (hints.length === 0) return scene
	const joined = hints.join(', ')
	return scene.startsWith(FULL_BODY_FRAMING)
		? `${FULL_BODY_FRAMING}, ${joined}${scene.slice(FULL_BODY_FRAMING.length)}`
		: `${joined}, ${scene}`
}

/** Scene without the image model's weight syntax ("(words:1.3)"), for the language model. */
function plainScene(scene: string): string {
	return scene.replace(/\(([^()]+?)(?::[\d.]+)?\)/g, '$1')
}

/** Profile outfit hints whose `match` appears in `text` (see PhotoSettings `outfitHints`). */
interface OutfitHints {
	scene: string[]
	negative: string[]
	level: PhotoLevel
	loras: ExtraLora[]
}

function outfitHints(hints: PhotoSettings['outfitHints'], text: string): OutfitHints {
	const scene: string[] = []
	const negative: string[] = []
	const loras: ExtraLora[] = []
	let level: PhotoLevel = 'normal'
	for (const hint of hints ?? []) {
		try {
			if (!new RegExp(hint.match, 'iu').test(text)) continue
		}
		catch {
			console.warn('[companion:chat] invalid outfit hint pattern', hint.match)
			continue
		}
		scene.push(hint.scene)
		if (hint.negative) negative.push(hint.negative)
		if (hint.level) level = maxLevel(level, hint.level)
		if (hint.lora) loras.push(hint.lora)
	}
	return { scene, negative, level, loras }
}

/** Profile reminders whose topic comes up in the last messages (see profile `reminders`). */
function reminderNotes(reminders: Reminder[] | undefined, window: CompanionMessage[], userName: string): string[] {
	const recent = window.slice(-REMINDER_CONTEXT_MESSAGES).map(asText).join('\n')
	return (reminders ?? []).filter(r => {
		try {
			return new RegExp(r.match, 'iu').test(recent)
		}
		catch {
			console.warn('[companion:chat] invalid reminder pattern', r.match)
			return false
		}
	// Marked as hers alone: otherwise the model answers it as if he had written it.
	}).map(r => `${r.note} (Information pour toi seule : ${userName} ne l'a pas écrit, ne la commente pas et n'y réponds pas.)`)
}

/**
 * History as the model sees it: photos are not text, it only needs to know one was sent (what
 * it shows goes in the closing note, see lastPhotoNote: inside her messages, the model starts
 * writing fake photos of its own). Invisible characters are dropped: once one is in the
 * history, the model copies it.
 */
function asText(m: CompanionMessage): string {
	return m.kind === 'image' ? '[Photo de toi envoyée]' : m.content.replace(INVISIBLE, '')
}

// A photo is only described while it is still being talked about.
const PHOTO_NOTE_RECENT_MESSAGES = 6

/** What her latest photo shows, while it is recent, so she knows what he is reacting to. */
function lastPhotoNote(window: CompanionMessage[], userName: string): string | null {
	const last = window.slice(-PHOTO_NOTE_RECENT_MESSAGES).filter(m => m.kind === 'image').at(-1)
	if (!last) return null
	return `[Ta dernière photo] Celle que tu as envoyée à ${userName} (il l'a vue) montre : ${plainScene(last.content)}.`
}

// Asides in parentheses are the model commenting on itself ("(je reste cohérente…)"), never part of a text.
const ASIDE = /\s*\([^)]{12,}\)\s*/g
// Zero-width characters survive trim(): a reply made only of them would be an empty bubble.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g
// The model sometimes copies the history's photo marker into its reply, or labels its caption.
const PHOTO_MARKER = /\[photo[^\]]*\]|^\s*(?:petit )?message(?: texte)?\s*:\s*/gim
// Some replies start with a made-up timestamp ("18:02 - Coucou…").
const TIMESTAMP_PREFIX = /^\s*\[?\d{1,2}[:h]\d{2}\]?\s*[-–:]?\s*/
// Roleplay actions between asterisks ("*éclate de rire*", "*envoie une photo…*") have no place in a text
// message. A short one inside a sentence is emphasis ("t'es *fou*"): only its asterisks go.
const STARRED = /\*([^*\n]*)\*/g
// …except that when she narrates sending a photo ("*envoie une photo de mes hanches en string*"),
// the app sends it for real, described from her words.
const PHOTO_ACTION = /\*([^*\n]*\b(?:envoie|envoies|envoyer|prends?|balance|mitraille)\b[^*\n]*\b(?:photos?|selfies?|pics?|clichés?)\b[^*\n]*)\*/i

function withoutActions(p: string): string {
	return p.replace(STARRED, (whole, inner: string, at: number, all: string) => {
		const after = all.slice(at + whole.length)
		const action = inner.trim().length >= 12 || at === 0 || /^\s*(?:$|[A-ZÀ-Ý])/.test(after)
		return action ? ' ' : inner
	}).replace(/\s{2,}/g, ' ')
}

/** Cleans a raw reply into chat bubbles: one per paragraph, minus speaker-label artifacts. */
function toBubbles(reply: string, name: string, trace: Trace): string[] {
	// "Yumi :" or "[Yumi]" at the start of a paragraph.
	const label = new RegExp(`^\\s*(?:\\[${name}\\]\\s*:?|${name}\\s*:)\\s*`, 'i')
	const actions = reply.match(STARRED)?.filter(a => a.replace(/\*/g, '').trim().length >= 12) ?? []
	if (actions.length > 0) trace('info', `${actions.length} action(s) entre astérisques retirée(s)`, actions.join('\n'))
	return reply
		.split(/\n\s*\n/)
		.map(p => p.replace(INVISIBLE, '').replace(PHOTO_MARKER, '').replace(label, '').replace(TIMESTAMP_PREFIX, '').replace(ASIDE, ' '))
		.map(p => withoutActions(p).trim())
		// Nothing left to read ("* *", a lone emoji is kept).
		.filter(p => p.length > 0 && !/^[\s*.…_~-]*$/.test(p))
		.map(p => {
			const { text, changed } = feminize(p)
			if (changed) trace('info', 'Masculin corrigé', `${p}\n→ ${text}`)
			return text
		})
}

const normalize = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Her pet phrases ("je mordille ma lèvre inférieure" in every message): three-word sequences
// found in several of her recent messages are named in a note so she varies them.
const PET_PHRASE_MESSAGES = 3
const MAX_PET_PHRASES = 5
const LINK_WORDS = new Set(['à', 'de', 'des', 'du', 'un', 'une', 'le', 'la', 'les', 'et', 'en', 'au', 'aux', 'ou', 'que', 'qui', 'ne', 'se', 'me', 'te'])

function petPhrases(recent: string[]): string[] {
	const counts = new Map<string, number>()
	for (const message of recent) {
		const words = normalize(message).split(' ')
		const grams = new Set<string>()
		for (let i = 0; i + 3 <= words.length; i++) {
			const gram = words.slice(i, i + 3)
			// A readable phrase: at least one real word, no elided "t" or "j", not starting or
			// ending on a small link word ("des limites à").
			if (gram.some(w => w.length >= 6) && gram.every(w => w.length > 1)
				&& !LINK_WORDS.has(gram[0]) && !LINK_WORDS.has(gram[2])) grams.add(gram.join(' '))
		}
		grams.forEach(g => counts.set(g, (counts.get(g) ?? 0) + 1))
	}
	const frequent = [...counts].filter(([, n]) => n >= PET_PHRASE_MESSAGES).sort((a, b) => b[1] - a[1]).map(([g]) => g)
	// Overlapping grams of one phrase ("mordille ma lèvre", "ma lèvre inférieure"): keep the first.
	const kept: string[] = []
	for (const g of frequent) {
		const words = g.split(' ')
		if (!kept.some(k => words.filter(w => k.split(' ').includes(w)).length >= 2)) kept.push(g)
	}
	return kept.slice(0, MAX_PET_PHRASES)
}

/**
 * Small models sometimes loop at the end of a generation, replaying earlier sentences.
 * Drops any sentence already said in this reply or in recent companion messages, then
 * caps the bubble count (a real person rarely sends more than a few in a row).
 */
function dedupeBubbles(bubbles: string[], recent: string[], trace: Trace): string[] {
	const seen = new Set<string>()
	const remember = (text: string) => {
		for (const s of text.split(/(?<=[.!?…])\s+/)) {
			const key = normalize(s)
			if (key.length >= MIN_DEDUP_SENTENCE_LENGTH) seen.add(key)
		}
	}
	recent.forEach(remember)

	const kept = bubbles
		.map(bubble => bubble
			.split(/(?<=[.!?…])\s+/)
			.filter(s => {
				const key = normalize(s)
				if (key.length < MIN_DEDUP_SENTENCE_LENGTH) return true
				if (seen.has(key)) {
					trace('warn', 'Phrase répétée retirée', s)
					return false
				}
				seen.add(key)
				return true
			})
			.join(' ')
			.trim())
		.filter(Boolean)

	// Extra paragraphs are dropped rather than merged: small models ramble once they get going.
	if (kept.length > MAX_BUBBLES) trace('info', `${kept.length - MAX_BUBBLES} paragraphe(s) en trop coupé(s)`, kept.slice(MAX_BUBBLES).join('\n\n'))
	return kept.slice(0, MAX_BUBBLES)
}

/** Her reply can be rewritten when it answers him and holds no photo (see Chat.regenerate). */
function canRegenerate(burst: CompanionMessage[]): boolean {
	return burst.length > 0 && burst.every(m => m.role === 'companion' && m.kind !== 'image' && !m.proactive)
}

/** One conversation's turns: her replies, reactions, initiatives and memory. */
export class Chat extends EventEmitter {
	private timer: NodeJS.Timeout | null = null
	/** id shared by the bubbles of the reply being written */
	private replyId: number | null = null
	private reactionTimer: NodeJS.Timeout | null = null
	private reactionReplies = 0
	private busy = false
	private pending = false
	private summaryTimer: NodeJS.Timeout | null = null
	private summarizing = false
	/** photo level forced by the testing shortcut, for the next reply */
	private forcedPhoto: PhotoLevel | null = null

	private readonly activity: ActivityEntry[] = []

	constructor(readonly store: ConversationStore) {
		super()
	}

	/** What happened in the background lately (oldest first). */
	activityLog(): ActivityEntry[] {
		return [...this.activity]
	}

	/** Adds a line to the activity log (and the console). */
	readonly trace: Trace = (level, text, detail) => {
		const entry: ActivityEntry = { id: nextActivityId++, at: Date.now(), level, text, ...(detail ? { detail } : {}) }
		this.activity.push(entry)
		if (this.activity.length > MAX_ACTIVITY_ENTRIES) this.activity.shift()
		const line = `[companion:${this.store.id}] ${text}`
		if (level === 'error') console.error(line, detail ?? '')
		else if (level === 'warn') console.warn(line)
		else console.log(line)
		this.emit('log', entry)
	}

	/** Runs the model, logging what it cost and how it ended. */
	private async runModel(purpose: string, model: string, messages: OllamaMessage[], options?: Record<string, unknown>): Promise<string> {
		const r = await ollamaChat(model, messages, options)
		if (r.cooledMs > 0) this.trace('warn', `GPU trop chaud : ${purpose.toLowerCase()} retardée de ${Math.round(r.cooledMs / 1_000)} s`)
		// A short limit (reaction emoji) is meant to stop it: only the normal limit counts as cut.
		const cut = r.cut && !options?.num_predict
		this.trace(cut ? 'warn' : 'info', `${purpose} : ${r.tokens} jetons en ${(r.ms / 1_000).toFixed(1)} s${cut ? ', coupée par la limite de longueur' : ''}`, r.content)
		return r.content
	}

	/** The user puts (or removes, with null) an emoji on one of her messages. */
	react(id: number, emoji: string | null): CompanionMessage | null {
		const target = this.store.getMessage(id)
		if (!target || target.role !== 'companion') return null
		const message = this.store.setReaction(id, 'user', emoji)
		if (message) this.emit('updated', message)
		// A reaction on any bubble counts for her whole reply.
		if (message?.replyId) this.recordReplyFeedback(message.replyId, 'reaction', emoji)
		if (message && emoji) this.maybeReplyToReaction(message)
		return message
	}

	/** A reaction to her latest message, with nothing written: like a person, she may answer it. */
	private maybeReplyToReaction(message: CompanionMessage): void {
		if (!this.store.listMessagesSinceLastUser().some(m => m.id === message.id)) return
		if (this.reactionReplies >= MAX_REACTION_REPLIES) return
		const probability = message.kind === 'image' ? REACTION_REPLY_PROBABILITY.image : REACTION_REPLY_PROBABILITY.other
		if (Math.random() > probability) return
		if (this.reactionTimer) clearTimeout(this.reactionTimer)
		const [min, max] = REACTION_REPLY_DELAY_MS
		this.reactionTimer = setTimeout(() => {
			this.reactionTimer = null
			if (!engine.isOn() || !this.isIdle()) return
			this.reactionReplies++
			const { userName } = this.store.profile()
			const note = `[Note] ${userName} vient de réagir à ton message sans rien écrire (voir Réactions). `
				+ 'Rebondis-y comme on le fait sur une messagerie : court et naturel (sourire, taquinerie, petite question). '
				+ 'Ne fais pas référence à cette note.'
			void this.generate(note, false, false)
		}, min + Math.random() * (max - min))
	}

	/**
	 * Rewrites her latest reply to his message (text or voice, no photo): the reply is
	 * deleted and generated again. Returns the deleted ids, or null when not possible.
	 */
	async regenerate(): Promise<number[] | null> {
		// A memory summary may be running (busy, but no reply on its way): the reply waits for it.
		if (!engine.isOn() || this.timer || this.reactionTimer || (this.busy && !this.summarizing)) return null
		const burst = this.store.listMessagesSinceLastUser()
		// The burst must answer a message of his (never the very start of the conversation).
		if (!canRegenerate(burst) || this.store.listMessages(burst.length + 1)[0]?.role !== 'user') return null
		const ids = burst.map(m => m.id)
		const replyIds = [...new Set(burst.map(m => m.replyId).filter((r): r is number => r !== null))]
		replyIds.forEach(replyId => this.recordReplyFeedback(replyId, 'rejected'))
		this.trace('info', 'Réponse rejetée : régénération', burst.map(m => m.content).join('\n\n'))
		this.store.deleteMessages(ids)
		this.emit('deleted', ids)
		if (this.busy) {
			this.pending = true
			this.setActivity('typing')
		}
		else void this.generate(null)
		return ids
	}

	/** Saves one of her replies with its context and how he received it (see the feedback table). */
	private recordReplyFeedback(replyId: number, signal: 'reaction' | 'rejected', emoji: string | null = null): void {
		const bubbles = this.store.listReply(replyId)
		if (bubbles.length === 0) return
		const { name, userName } = this.store.profile()
		const line = (m: CompanionMessage) => `${m.role === 'user' ? userName : name} : ${asText(m)}`
		this.store.recordFeedback({
			replyId,
			signal,
			emoji,
			reply: bubbles.map(asText).join('\n\n'),
			context: this.store.listMessages(FEEDBACK_CONTEXT_MESSAGES, bubbles[0].id).map(line).join('\n')
		})
	}

	send(content: string): CompanionMessage {
		// He is writing: his message is what she answers, reaction included.
		if (this.reactionTimer) clearTimeout(this.reactionTimer)
		this.reactionTimer = null
		this.reactionReplies = 0
		this.cancelSummary()
		const forced = FORCED_PHOTO.exec(content)
		if (forced) {
			this.forcedPhoto = forced[1].toLowerCase() as PhotoLevel
			content = content.slice(forced[0].length)
		}
		const message = this.store.insertMessage({ role: 'user', content })
		this.emit('message', message)
		this.scheduleReply()
		return message
	}

	/** Answers a user message left without reply (e.g. sent while the engine was off). */
	respondIfPending(): void {
		const last = this.store.listMessages(1)[0]
		if (last?.role === 'user') this.scheduleReply()
	}

	private scheduleReply(): void {
		if (this.timer) clearTimeout(this.timer)
		this.timer = setTimeout(() => {
			this.timer = null
			void this.reply()
		}, REPLY_DEBOUNCE_MS)
	}

	private activityNow: CompanionActivity = null

	private setActivity(activity: CompanionActivity): void {
		this.activityNow = activity
		this.emit('activity', activity)
	}

	/** What she is doing right now (for a page opened mid-reply). */
	currentActivity(): CompanionActivity {
		return this.activityNow
	}

	/** True when no reply is pending or being written. */
	isIdle(): boolean {
		return !this.busy && !this.timer && !this.reactionTimer
	}

	/**
	 * Lets the companion write first. `instruction` is a closing system note telling her
	 * why/how to reach out; `withPhoto` makes her send a photo of herself along.
	 * Returns false when a conversation turn is already in flight.
	 */
	async initiate(instruction: string, withPhoto = false): Promise<boolean> {
		if (!engine.isOn() || !this.isIdle()) return false
		await this.generate(instruction, withPhoto && photo.isAvailable())
		return true
	}

	private async reply(): Promise<void> {
		if (!engine.isOn()) return
		if (this.busy) {
			this.pending = true
			return
		}
		await this.generate(null)
	}

	/**
	 * @param initiative closing note when she writes without a new message from him to answer
	 * @param proactive  false for a bounce on his reaction: it answers him, it is no initiative
	 */
	private async generate(initiative: string | null, initiativePhoto = false, proactive = initiative !== null): Promise<void> {
		this.cancelSummary()
		this.busy = true
		this.replyId = Date.now()
		this.setActivity('typing')
		let endTurn: (() => void) | null = null
		try {
			endTurn = await gpuTurn()
			const profile = this.store.profile()
			const memory = this.store.getLatestMemory()
			const { older, window } = splitWindow(this.store.listMessagesAfter(memory?.uptoMessageId ?? 0))

			// When replying, the last message is the user's: elapsed time is measured before it.
			const lastExchange = initiative ? window.at(-1) : window.at(-2)
			const system = memory ? `[Mémoire de ${profile.name} sur ${profile.userName}]\n${memory.summary}` : ''
			const stage = currentStage(profile.relationship, this.store.conversationAge())
			const reactions = reactionNote(window, profile.userName)
			const mood = conversationLevel(window.slice(-PHOTO_CONTEXT_MESSAGES).map(asText).join('\n'))
			const pets = petPhrases(window.filter(m => m.role === 'companion' && m.kind !== 'image').slice(-8).map(m => m.content))
			const timeNote = contextNote(profile.userName, lastExchange?.createdAt ?? null)
				+ (stage ? `\n[Où vous en êtes] ${stage.note}` : '')
				+ (LEVEL_NOTE[mood] ? `\n${LEVEL_NOTE[mood]}` : '')
				+ (reactions ? `\n${reactions}` : '')
				+ (lastPhotoNote(window, profile.userName) ? `\n${lastPhotoNote(window, profile.userName)}` : '')
				+ reminderNotes(profile.reminders, window, profile.userName).map(note => `\n${note}`).join('')
				+ (pets.length > 0 ? `\n[Style] Tu répètes trop ces expressions : ${pets.map(p => `« ${p} »`).join(', ')}. Ne les réutilise pas : varie tes gestes et tes mots.` : '')
			const history: OllamaMessage[] = [
				...(system ? [{ role: 'system' as const, content: system }] : []),
				...window.map<OllamaMessage>(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: asText(m) }))
			]

			// Like reading his message before typing: sometimes she reacts to it first.
			if (!initiative) {
				const stageIndex = stage ? profile.relationship.indexOf(stage) : 1
				await this.maybeReact(window.at(-1), history, profile.userName, stageIndex >= 1)
			}

			// The user's messages since her last reply: did they ask to hear her?
			const pendingUser: string[] = []
			for (let i = window.length - 1; i >= 0 && window[i].role === 'user' && !initiative; i--) pendingUser.unshift(window[i].content)
			const pendingUserText = pendingUser.join('\n')
			const wantsVoice = voice.isAvailable() && voiceRequested(pendingUserText)
			const recentText = window.slice(-PHOTO_CONTEXT_MESSAGES).map(asText).join('\n')
			const hour = new Date().getHours()
			const night = hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR
			const cap = (night ? stage?.photoCapNight : undefined) ?? stage?.photoCap ?? 'hard'
			const forcedPhoto = initiative ? null : this.forcedPhoto
			if (!initiative) this.forcedPhoto = null
			const photoWish: PhotoDecision = initiativePhoto
				? { kind: 'send', level: photoLevelOf(mood) }
				: forcedPhoto && photo.isAvailable() ? { kind: 'send', level: forcedPhoto }
					: photo.isAvailable() && !initiative ? photoDecision(pendingUserText, recentText, cap) : { kind: 'none' }
			// The scene is written before her message, from the conversation and his request only,
			// so her message matches the photo instead of the photo following her inventions.
			const hints = photoWish.kind === 'send' ? outfitHints(profile.photo?.outfitHints, `${recentText}\n${pendingUserText}`) : null
			if (hints && wantsRearView(pendingUserText)) {
				hints.scene.unshift(REAR_VIEW.scene)
				hints.negative.push(REAR_VIEW.negative)
			}
			// An outfit hint may raise the level (lingerie on the safe checkpoint ends up covered).
			const photoLevel: PhotoLevel = photoWish.kind === 'send' ? maxLevel(photoWish.level, hints!.level) : 'normal'
			const described = photoWish.kind === 'send'
				? await this.describePhoto(recentText, pendingUserText, photoLevel, wantsFullBody(pendingUserText))
				: null
			const scene = described && hints ? withOutfitHints(described, hints.scene) : described
			if (photoWish.kind === 'tease') this.trace('info', `Photo demandée trop osée pour le moment (plafond ${cap}) : elle se fait désirer`)
			if (forcedPhoto) this.trace('info', `Photo forcée par le code /${forcedPhoto}`)
			// The photo goes out first (it takes minutes) and her message is written after it, from what
			// it really shows. Without the photo, a "here you go" would make no sense: nothing is sent.
			let shown: string | null = null
			if (scene) {
				const sent = await this.sendPhoto(scene, photoLevel, hints!, proactive)
				if (!sent) return
				shown = shownByTags(sent.tags) || plainScene(scene)
				this.setActivity('typing')
			}
			const closingNote = initiative
				? (shown ? `${initiative}\n${photoInitiativeNote(shown)}` : initiative)
				: (shown ? photoNote(shown) : photoWish.kind === 'tease' ? TEASE_NOTE : null)
					?? (wantsVoice ? VOICE_REQUEST_NOTE : null)

			const recent = window.filter(m => m.role === 'companion' && m.kind !== 'image').slice(-10).map(m => m.content)
			let bubbles: string[] = []
			let note = closingNote ? `${timeNote}\n${closingNote}` : timeNote
			this.trace('info', initiative ? 'Consignes (initiative)' : 'Consignes de la réponse', note)
			const heReachedIt = CLIMAX.test(window.filter(m => m.role === 'user').slice(-3).map(m => m.content).join('\n'))
			let climaxRetried = mood !== 'fantasy' || heReachedIt
			let refusalRetried = false
			let raw = ''
			// A reply can come back empty once cleaned (only invisible characters…): one more try.
			for (let attempt = 0; attempt < 3 && bubbles.length === 0; attempt++) {
				const reply = await this.runModel(attempt === 0 ? 'Réponse' : 'Réponse réécrite', profile.model, [...history, { role: 'system', content: note }])
				raw = reply
				bubbles = dedupeBubbles(toBubbles(reply, profile.name, this.trace), recent, this.trace)
				if (bubbles.length === 0) this.trace('warn', 'Réponse vide une fois nettoyée, nouvel essai', reply)
				else if (scene && !refusalRetried && REFUSAL.test(bubbles.join('\n'))) {
					this.trace('warn', 'Le message refuse la photo qu\'il accompagne : réécriture', bubbles.join('\n\n'))
					refusalRetried = true
					note = `${note}\n${REFUSAL_RETRY_NOTE}`
					bubbles = []
				}
				else if (!climaxRetried && CLIMAX.test(bubbles.join('\n'))) {
					this.trace('warn', 'Orgasme trop tôt dans la scène : réécriture', bubbles.join('\n\n'))
					climaxRetried = true
					note = `${note}\n${CLIMAX_RETRY_NOTE}`
					bubbles = []
				}
			}
			const text = bubbles.join('\n\n')
			const action = !scene && photo.isAvailable() && bubbles.length > 0 ? PHOTO_ACTION.exec(raw)?.[1].trim() : undefined
			if (action) await this.sendAnnouncedPhoto(action, recentText, cap, proactive)
			// A photo comes with a written message, unless he explicitly asked for a voice one.
			const register = text && voice.isAvailable() && (photoWish.kind !== 'send' || wantsVoice)
				? voiceRegisterFor(text, wantsVoice, window.slice(-4).some(m => m.role === 'companion' && m.kind === 'audio')) : null
			if (!(register && await this.sendVoice(text, register, proactive))) {
				for (const [i, bubble] of bubbles.entries()) {
					if (i > 0 || scene) await new Promise(r => setTimeout(r, BUBBLE_GAP_MS))
					this.emit('message', this.store.insertMessage({ role: 'companion', content: bubble, proactive, replyId: this.replyId }))
				}
			}

			if (older.length > 0) this.scheduleSummary()
		}
		catch (err) {
			this.trace('error', 'Échec de la génération', err instanceof Error ? err.message : String(err))
			this.emit('error', err instanceof Error ? err.message : String(err))
		}
		finally {
			endTurn?.()
			this.setActivity(null)
			this.busy = false
			if (this.pending) {
				this.pending = false
				this.scheduleReply()
			}
		}
	}

	/**
	 * Lets her put an emoji on his last message, now and then. The persona model picks it
	 * (same prompt prefix as the reply, so it mostly reuses the cache); anything else than an
	 * allowed emoji counts as no reaction.
	 */
	private async maybeReact(target: CompanionMessage | undefined, history: OllamaMessage[], userName: string, love: boolean): Promise<void> {
		if (!target || target.role !== 'user' || target.companionReaction || Math.random() > REACTION_PROBABILITY) return
		const allowed = love ? [...REACTIONS, ...LOVE_REACTIONS] : REACTIONS
		try {
			const raw = await this.runModel('Réaction', this.store.profile().model, [
				...history,
				{
					role: 'system',
					content: `[Réaction] Comme sur une messagerie, tu peux mettre une réaction emoji sur le dernier message de ${userName}, `
						+ "seulement s'il t'a vraiment fait rire, touchée, émoustillée ou surprise. "
						+ `Choisis parmi : ${allowed.join(' ')}. La plupart du temps tu n'en mets pas : réponds alors « aucune ». `
						+ "Réponds uniquement par l'emoji ou par « aucune »."
				}
			], { num_predict: 8 })
			if (raw.length > 24) return
			// The heart may come back without its variation selector.
			const emoji = allowed.find(e => raw.includes(e.replace('\uFE0F', '')))
			if (!emoji) return
			const message = this.store.setReaction(target.id, 'companion', emoji)
			this.trace('info', `Réaction ${emoji} sur son message`)
			if (message) this.emit('updated', message)
		}
		catch (err) {
			this.trace('warn', 'Échec de la réaction', String(err))
		}
	}

	/**
	 * Sends `text` as a voice message (the transcript is kept as the message content).
	 * Returns false when synthesis fails, so the caller falls back to plain text.
	 */
	private async sendVoice(text: string, register: VoiceRegister, proactive: boolean): Promise<boolean> {
		this.setActivity('recording')
		try {
			const { file, durationMs } = await voice.synthesize(this.store.mediaDir(), toSpokenFrench(text), register)
			this.trace('info', `Vocal ${register === 'excited' ? 'excité' : 'normal'} de ${Math.round(durationMs / 1_000)} s`, text)
			this.emit('message', this.store.insertMessage({ role: 'companion', kind: 'audio', content: text, mediaPath: file, proactive, replyId: this.replyId }))
			return true
		}
		catch (err) {
			this.trace('error', 'Échec du vocal, envoyé en texte', String(err))
			return false
		}
	}

	/**
	 * Sends the photo he asked for. The scene is written by the persona-free model from the
	 * conversation; the character's look and the photographic style are added by the service.
	 * Returns null when it could not be generated.
	 */
	private async sendPhoto(scene: string, level: PhotoLevel, hints: OutfitHints, proactive: boolean): Promise<PhotoResult | null> {
		this.setActivity('photo')
		const negative = hints.negative.join(', ')
		const expect = expectedTags(scene)
		try {
			const result = await photo.generate(this.store.mediaDir(), scene, level, negative, hints.loras, expect)
			const lacking = expect.filter(group => !group.some(tag => result.tags.includes(tag)))
			const detail = `Scène : ${scene}${negative ? `\nNégatif : ${negative}` : ''}${result.tags.length ? `\nÉtiquettes : ${result.tags.join(', ')}` : ''}`
			this.trace(result.matched ? 'info' : 'warn', result.matched
				? `Photo ${level} envoyée`
				: `Photo ${level} envoyée sans tout ce qui était demandé (manque : ${lacking.map(g => g[0]).join(', ')})`, detail)
			this.emit('message', this.store.insertMessage({ role: 'companion', kind: 'image', content: scene, mediaPath: result.file, proactive, replyId: this.replyId }))
			return result
		}
		catch (err) {
			this.trace('error', `Échec de la photo ${level}`, `${String(err)}\nScène : ${scene}`)
			this.emit('error', 'the photo could not be generated')
			return null
		}
	}

	/**
	 * Sends the photo she narrated sending ("*envoie une photo de…*"), from her description and
	 * the conversation. Her message follows it whether or not it could be generated.
	 */
	private async sendAnnouncedPhoto(action: string, recentText: string, cap: PhotoLevel, proactive: boolean): Promise<void> {
		const { name, photo: settings } = this.store.profile()
		const hints = outfitHints(settings?.outfitHints, `${recentText}\n${action}`)
		if (showsOwnRearView(action)) {
			hints.scene.unshift(REAR_VIEW.scene)
			hints.negative.push(REAR_VIEW.negative)
		}
		const level = minLevel(maxLevel(ownPhotoLevel(action, recentText, cap), hints.level), cap)
		this.trace('info', `Elle annonce une photo : envoi d'une photo ${level}`, action)
		this.setActivity('photo')
		const described = await this.describePhoto(`${recentText}\n${name} : ${action}`, '', level, wantsFullBody(action))
		await this.sendPhoto(withOutfitHints(described, hints.scene), level, hints, proactive)
		this.setActivity('typing')
	}

	/**
	 * One line of English keywords describing the photo, written by the persona-free model
	 * from the conversation. Small models sometimes answer with garbage: the line is checked,
	 * retried once, and replaced by a generic scene if still unusable.
	 * @param request  his messages asking for the photo (empty when she sends one on her own)
	 * @param fullBody he wants to see an outfit or her whole body: the framing is imposed
	 */
	private async describePhoto(context: string, request: string, level: PhotoLevel, fullBody: boolean): Promise<string> {
		const { name, userName, summaryModel } = this.store.profile()
		const prompt = [
			`${name} est une femme adulte de 25 ans qui envoie à ${userName} une photo d'elle prise avec son téléphone.`,
			'Décris cette photo en ANGLAIS, sur une seule ligne de mots-clés séparés par des virgules : cadrage, tenue ou nudité,',
			'pose, lieu, lumière, expression. 12 à 40 mots, sans prénom ni description de son visage ou de son corps.',
			...(fullBody
				? [`Cadrage imposé : ${userName} veut voir sa tenue en entier, c'est un selfie miroir en pied ("${FULL_BODY_FRAMING}").`]
				: [
					'Cadrage : de préférence un selfie qu\'elle prend elle-même à bout de bras, vu de haut, serré sur le visage et le buste',
					'("arm\'s length selfie, high angle, close framing"). Si la pose rend le selfie impossible (de dos, à quatre pattes…),',
					'"phone propped up nearby, close framing". Selfie miroir seulement si la conversation parle d\'un miroir.'
				]),
			'Le lieu est chez elle (sa chambre, son lit, son salon, sa salle de bain), sauf si la conversation la place ailleurs.',
			'La pose est exactement celle qu\'il demande, sans l\'adoucir ni la changer.',
			'La tenue est exactement celle dont parle la conversation, décrite précisément avec ses détails',
			'(très court, minuscule, transparent, échancré…), sans rien changer ni ajouter.',
			LEVEL_SCENE[level],
			'Exemple de réponse : arm\'s length selfie, high angle, close framing, oversized grey hoodie, sitting on her bed, soft lamp light, playful smile',
			'',
			`Conversation :\n${context}`,
			'',
			...(request ? [`Ce que ${userName} demande : ${request}`, ''] : []),
			'Réponds uniquement par la ligne de mots-clés.'
		].join('\n')
		for (let attempt = 0; attempt < 2; attempt++) {
			const raw = await this.runModel('Scène photo', summaryModel, [{ role: 'user', content: prompt }])
			const line = raw.split('\n').map(l => l.replace(/^["'\s*-]+|["'\s]+$/g, '')).find(l => l.length > 0) ?? ''
			const words = line.match(/[a-z]{3,}/gi)?.length ?? 0
			if (words >= 6 && !/[àâéèêîôûç]/i.test(line)) return fullBody ? withFullBodyFraming(line) : line
			this.trace('warn', 'Scène photo inutilisable, nouvel essai', line)
		}
		const fallback = FALLBACK_SCENE[level]
		return fullBody ? withFullBodyFraming(fallback) : fallback
	}

	private cancelSummary(): void {
		if (this.summaryTimer) clearTimeout(this.summaryTimer)
		this.summaryTimer = null
	}

	/** Runs the memory summary once the conversation has been quiet for a while. */
	private scheduleSummary(): void {
		this.cancelSummary()
		this.summaryTimer = setTimeout(() => {
			this.summaryTimer = null
			// Busy or about to answer: the next reply schedules it again.
			if (!engine.isOn() || !this.isIdle()) return
			void this.runSummary()
		}, SUMMARY_IDLE_MS)
	}

	private async runSummary(): Promise<void> {
		this.busy = true
		this.summarizing = true
		let endTurn: (() => void) | null = null
		try {
			endTurn = await gpuTurn()
			const memory = this.store.getLatestMemory()
			const { older } = splitWindow(this.store.listMessagesAfter(memory?.uptoMessageId ?? 0))
			if (older.length > 0) await this.summarize(older, memory?.summary ?? null)
		}
		catch (err) {
			this.trace('error', 'Échec du résumé de mémoire', String(err))
		}
		finally {
			endTurn?.()
			this.busy = false
			this.summarizing = false
			if (this.pending) {
				this.pending = false
				this.scheduleReply()
			}
		}
	}

	/** Folds messages that left the window into the long-term memory summary. */
	private async summarize(older: CompanionMessage[], previous: string | null): Promise<void> {
		const { name, userName, summaryModel } = this.store.profile()
		const transcript = older
			.map(m => `${m.role === 'user' ? userName : name} : ${asText(m)}`
				+ (m.userReaction ? ` (réaction de ${userName} : ${m.userReaction})` : '')
				+ (m.companionReaction ? ` (réaction de ${name} : ${m.companionReaction})` : ''))
			.join('\n')
		const summary = await this.runModel('Résumé de mémoire', summaryModel, [{
			role: 'user',
			content: [
				`Tu tiens la mémoire à long terme de ${name} sur sa relation avec ${userName}.`,
				`Mets à jour la mémoire existante avec les nouveaux échanges : faits importants sur ${userName}`,
				'(vie, travail, goûts, envies), moments marquants entre eux, choses promises ou en cours.',
				'Écris en français, en puces courtes, 25 lignes maximum, sans recopier les échanges.',
				'',
				`Mémoire existante :\n${previous ?? '(vide)'}`,
				'',
				`Nouveaux échanges :\n${transcript}`
			].join('\n')
		}])
		this.store.insertMemory(older.at(-1)!.id, summary)
		this.trace('info', `Mémoire mise à jour (${older.length} messages résumés)`, summary)
	}
}
