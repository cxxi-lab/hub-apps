import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type MessageRole = 'user' | 'companion'
export type MessageKind = 'text' | 'image' | 'audio'

export interface CompanionMessage {
	id: number
	role: MessageRole
	kind: MessageKind
	content: string
	mediaPath: string | null
	createdAt: number
	readAt: number | null
	proactive: boolean
	/** emoji the user put on this message (on hers), the companion on his */
	userReaction: string | null
	userReactionAt: number | null
	companionReaction: string | null
	/** shared by the bubbles (text, voice, photo) of one reply of hers */
	replyId: number | null
}

export interface CompanionProfile {
	name: string
	/** name shown in the app when it differs from `name` (two conversations with the same persona) */
	label?: string
	/** profile picture, a file of the media dir */
	avatar?: string
	/** how the companion calls the user */
	userName: string
	/** Ollama model holding the persona (built outside this repo) */
	model: string
	/** model used for memory summaries — persona-free, ideally the same weights */
	summaryModel: string
	proactive: ProactiveSettings
	/** voice messages; null disables them */
	voice: VoiceSettings | null
	/** photos; null disables them */
	photo: PhotoSettings | null
	/**
	 * How the relationship evolves over time: the first stage whose thresholds are not both
	 * reached yet applies, and its note is given to the model before each reply.
	 */
	relationship: RelationshipStage[]
	/**
	 * Notes given right before her reply when the recent messages touch their topic: facts a
	 * small model loses in a long context (who is who, what her body looks like…).
	 */
	reminders?: Reminder[]
	/** GPU clock range ("min,max" MHz) applied while the engine runs; needs a sudoers rule */
	gpuClockLock: string | null
	/** lower clock caps applied as the GPU heats up (each needs its own sudoers entry) */
	gpuThermalSteps?: { aboveTemp: number; clockLock: string }[]
	/** GPU power cap while the engine runs, and the value to restore after; needs a sudoers rule */
	gpuPowerLimit: { watts: number; restoreWatts: number } | null
}

export interface VoiceReference {
	/** reference recording to clone (wav) */
	audio: string
	/** exact transcript of `audio` */
	text: string
}

export interface Reminder {
	/** case-insensitive regular expression, tested on the last few messages */
	match: string
	note: string
}

export interface RelationshipStage {
	/** stage lasts until the conversation is this many days old… */
	untilDays?: number
	/** …and has this many messages (both must be reached to move on) */
	untilMessages?: number
	/** behaviour for this stage, given to the model */
	note: string
	/** most daring photo she sends at this stage (default: hard) */
	photoCap?: 'normal' | 'soft' | 'hard'
	/** cap at night (22:00–6:00), when it differs: a stage can keep explicit photos for the night */
	photoCapNight?: 'normal' | 'soft' | 'hard'
}

export interface PhotoSettings {
	/** ComfyUI install (with Impact Pack) and its Python interpreter (`~/` allowed) */
	comfyDir: string
	comfyPython: string
	comfyPort?: number
	/** InsightFace models root, for the apparent-age and resemblance checks */
	insightfaceRoot: string
	/** reference picture of her face; photos that do not resemble it are regenerated */
	faceRef?: string
	/** JoyTag tagger (model.onnx + top_tags.txt): checks the photo shows what was asked, tells her what it shows */
	taggerDir?: string
	/** checkpoint file names in ComfyUI/models/checkpoints */
	checkpoints: { sfw: string; nsfw: string }
	/** character LoRA in ComfyUI/models/loras, once trained */
	lora?: { file: string; strength?: number; strengthNsfw?: number }
	triggerWord?: string
	/** fixed physical description, prepended to every scene */
	character: string
	/** details only visible on explicit photos, appended to `character` for those */
	characterNsfw?: string
	/** photographic style (amateur smartphone look…) */
	style: string
	/** extra negative prompt; child-related terms are always added by the service */
	negative?: string
	/**
	 * Outfit details a small model loses when describing the scene: when `match` (regular
	 * expression) appears in the recent messages, `scene` is added to the photo prompt and
	 * `negative` to its negative prompt; `level` raises the photo to at least that level
	 * (lingerie the safe checkpoint would cover up).
	 */
	outfitHints?: { match: string; scene: string; negative?: string; level?: 'soft' | 'hard'; lora?: ExtraLora }[]
}

/** Concept LoRA in ComfyUI/models/loras, loaded on top of the character's for some photos. */
export interface ExtraLora {
	file: string
	strength?: number
}

export interface VoiceSettings {
	/** Python interpreter of the env where qwen-tts is installed (`~/` allowed) */
	python: string
	/** Hugging Face id of the Qwen3-TTS Base model */
	model: string
	/** one reference per register; `excited` falls back to `normal` */
	refs: { normal: VoiceReference; excited?: VoiceReference }
}

export interface ProactiveSettings {
	enabled: boolean
	/** random delay between two "should I write?" checks */
	minIntervalMinutes: number
	maxIntervalMinutes: number
	/** optional local hours [start, end) during which she never writes first */
	quietHours: [number, number] | null
	/** never write first while the user was active this recently */
	activeChatCooldownMinutes: number
	/** stop reaching out after this many unanswered initiatives */
	maxUnanswered: number
}

// Everything stays on this machine: conversation, memory and (later) media live under the
// app data dir, never on the hub server. Pinned to the packaged product name: userData
// differs between dev (package name) and the AppImage, and both must share one conversation.
export function dataDir(): string {
	const dir = path.join(app.getPath('appData'), 'hub', 'companion')
	mkdirSync(dir, { recursive: true })
	return dir
}

export const MAIN_CONVERSATION = 'main'
const CONVERSATION_ID = /^[a-z0-9][a-z0-9-]*$/

export function conversationDir(id: string): string {
	if (id === MAIN_CONVERSATION) return dataDir()
	if (!CONVERSATION_ID.test(id)) throw new Error(`invalid conversation id: ${id}`)
	const dir = path.join(dataDir(), 'conversations', id)
	mkdirSync(dir, { recursive: true })
	return dir
}

/** The main conversation, then each conversations/<id>/ folder holding a profile.json. */
export function listConversationIds(): string[] {
	const root = path.join(dataDir(), 'conversations')
	const others = existsSync(root)
		? readdirSync(root, { withFileTypes: true })
			.filter(d => d.isDirectory() && CONVERSATION_ID.test(d.name) && existsSync(path.join(root, d.name, 'profile.json')))
			.map(d => d.name)
			.sort()
		: []
	return [MAIN_CONVERSATION, ...others]
}

const profilePath = (): string => path.join(dataDir(), 'profile.json')
const DEFAULT_PROFILE: CompanionProfile = {
	name: 'Companion',
	userName: 'User',
	model: 'companion',
	summaryModel: 'companion',
	proactive: {
		enabled: true,
		minIntervalMinutes: 30,
		maxIntervalMinutes: 120,
		quietHours: null,
		activeChatCooldownMinutes: 20,
		maxUnanswered: 5
	},
	voice: null,
	photo: null,
	relationship: [],
	gpuClockLock: null,
	gpuPowerLimit: null
}

export function getProfile(): CompanionProfile {
	if (!existsSync(profilePath())) {
		writeFileSync(profilePath(), JSON.stringify(DEFAULT_PROFILE, null, '\t'))
		return DEFAULT_PROFILE
	}
	try {
		const stored = JSON.parse(readFileSync(profilePath(), 'utf8')) as Partial<CompanionProfile>
		return { ...DEFAULT_PROFILE, ...stored, proactive: { ...DEFAULT_PROFILE.proactive, ...stored.proactive } }
	}
	catch (err) {
		console.warn('[companion] invalid profile.json, using defaults', err)
		return DEFAULT_PROFILE
	}
}

function openDb(dir: string): DatabaseSync {
	const db = new DatabaseSync(path.join(dir, 'companion.db'))
	db.exec(`
		PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS message (
			id          INTEGER PRIMARY KEY,
			role        TEXT NOT NULL CHECK (role IN ('user', 'companion')),
			kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'image', 'audio')),
			content     TEXT NOT NULL,
			media_path  TEXT,
			created_at  INTEGER NOT NULL,
			read_at     INTEGER,
			proactive   INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE IF NOT EXISTS memory (
			id               INTEGER PRIMARY KEY,
			upto_message_id  INTEGER NOT NULL,
			summary          TEXT NOT NULL,
			created_at       INTEGER NOT NULL
		);
	`)
	// Columns added after the first release: older databases get them on the fly.
	const columns = new Set((db.prepare('PRAGMA table_info(message)').all() as { name: string }[]).map(c => c.name))
	for (const [name, type] of [['user_reaction', 'TEXT'], ['user_reaction_at', 'INTEGER'], ['companion_reaction', 'TEXT'], ['reply_id', 'INTEGER']]) {
		if (!columns.has(name)) db.exec(`ALTER TABLE message ADD COLUMN ${name} ${type}`)
	}
	// How the user received her replies (reactions, regenerations): material for a future fine-tuning.
	db.exec(`
		CREATE TABLE IF NOT EXISTS feedback (
			id          INTEGER PRIMARY KEY,
			reply_id    INTEGER NOT NULL,
			signal      TEXT NOT NULL CHECK (signal IN ('reaction', 'rejected')),
			emoji       TEXT,
			reply       TEXT NOT NULL,
			context     TEXT NOT NULL,
			created_at  INTEGER NOT NULL
		);
	`)
	return db
}

interface MessageRow {
	id: number
	role: MessageRole
	kind: MessageKind
	content: string
	media_path: string | null
	created_at: number
	read_at: number | null
	proactive: number
	user_reaction: string | null
	user_reaction_at: number | null
	companion_reaction: string | null
	reply_id: number | null
}

const toMessage = (r: MessageRow): CompanionMessage => ({
	id: r.id,
	role: r.role,
	kind: r.kind,
	content: r.content,
	mediaPath: r.media_path,
	createdAt: r.created_at,
	readAt: r.read_at,
	proactive: r.proactive === 1,
	userReaction: r.user_reaction,
	userReactionAt: r.user_reaction_at,
	companionReaction: r.companion_reaction,
	replyId: r.reply_id
})

export interface Memory {
	uptoMessageId: number
	summary: string
}

/**
 * One conversation: its database (messages, memory, feedback), media and profile. The first
 * conversation lives right in the data dir; the others in conversations/<id>/, with a
 * profile.json holding only what differs from the main one (model, label…).
 */
export class ConversationStore {
	private readonly db: DatabaseSync

	constructor(readonly id: string) {
		this.db = openDb(this.dir())
	}

	dir(): string {
		return conversationDir(this.id)
	}

	/** Where voice messages and photos are stored (served to the app through companion-media://). */
	mediaDir(): string {
		const dir = path.join(this.dir(), 'media')
		mkdirSync(dir, { recursive: true })
		return dir
	}

	profile(): CompanionProfile {
		const main = getProfile()
		if (this.id === MAIN_CONVERSATION) return main
		const file = path.join(this.dir(), 'profile.json')
		try {
			const stored = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<CompanionProfile> : {}
			return { ...main, ...stored, proactive: { ...main.proactive, ...stored.proactive } }
		}
		catch (err) {
			console.warn(`[companion] invalid profile.json in conversation ${this.id}, using the main one`, err)
			return main
		}
	}

	insertMessage(m: {
		role: MessageRole
		kind?: MessageKind
		content: string
		mediaPath?: string | null
		proactive?: boolean
		replyId?: number | null
	}): CompanionMessage {
		const now = Date.now()
		const res = this.db.prepare(`
			INSERT INTO message (role, kind, content, media_path, created_at, read_at, proactive, reply_id)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`).run(m.role, m.kind ?? 'text', m.content, m.mediaPath ?? null, now, m.role === 'user' ? now : null, m.proactive ? 1 : 0, m.replyId ?? null)
		return this.getMessage(Number(res.lastInsertRowid))!
	}

	getMessage(id: number): CompanionMessage | null {
		const row = this.db.prepare('SELECT * FROM message WHERE id = ?').get(id) as MessageRow | undefined
		return row ? toMessage(row) : null
	}

	/** Sets (or clears, with null) the user's or the companion's reaction to a message. */
	setReaction(id: number, by: MessageRole, emoji: string | null): CompanionMessage | null {
		if (by === 'user') {
			this.db.prepare('UPDATE message SET user_reaction = ?, user_reaction_at = ? WHERE id = ?').run(emoji, emoji ? Date.now() : null, id)
		}
		else {
			this.db.prepare('UPDATE message SET companion_reaction = ? WHERE id = ?').run(emoji, id)
		}
		return this.getMessage(id)
	}

	deleteMessages(ids: number[]): void {
		const stmt = this.db.prepare('DELETE FROM message WHERE id = ?')
		for (const id of ids) stmt.run(id)
	}

	/** Bubbles of one reply of hers, oldest first. */
	listReply(replyId: number): CompanionMessage[] {
		const rows = this.db.prepare('SELECT * FROM message WHERE reply_id = ? ORDER BY id').all(replyId) as unknown as MessageRow[]
		return rows.map(toMessage)
	}

	/**
	 * Records how he received one of her replies. A reply has at most one reaction row (the
	 * latest emoji, or none once removed); each regeneration adds a "rejected" row.
	 */
	recordFeedback(f: { replyId: number; signal: 'reaction' | 'rejected'; emoji?: string | null; reply: string; context: string }): void {
		if (f.signal === 'reaction') this.db.prepare("DELETE FROM feedback WHERE reply_id = ? AND signal = 'reaction'").run(f.replyId)
		if (f.signal === 'reaction' && !f.emoji) return
		this.db.prepare('INSERT INTO feedback (reply_id, signal, emoji, reply, context, created_at) VALUES (?, ?, ?, ?, ?, ?)')
			.run(f.replyId, f.signal, f.emoji ?? null, f.reply, f.context, Date.now())
	}

	/** When the user last reacted to one of her messages (a reaction answers her, like a reply). */
	lastUserReactionAt(): number | null {
		const row = this.db.prepare('SELECT MAX(user_reaction_at) AS at FROM message').get() as { at: number | null }
		return row.at
	}

	/** Latest messages, oldest first; `beforeId` pages backwards. */
	listMessages(limit: number, beforeId?: number): CompanionMessage[] {
		const rows = (beforeId
			? this.db.prepare('SELECT * FROM message WHERE id < ? ORDER BY id DESC LIMIT ?').all(beforeId, limit)
			: this.db.prepare('SELECT * FROM message ORDER BY id DESC LIMIT ?').all(limit)) as unknown as MessageRow[]
		return rows.reverse().map(toMessage)
	}

	listMessagesAfter(afterId: number): CompanionMessage[] {
		const rows = this.db.prepare('SELECT * FROM message WHERE id > ? ORDER BY id').all(afterId) as unknown as MessageRow[]
		return rows.map(toMessage)
	}

	/** Messages after the user's last one (all of them if the user never wrote). */
	listMessagesSinceLastUser(): CompanionMessage[] {
		const rows = this.db.prepare(`
			SELECT * FROM message
			WHERE id > COALESCE((SELECT MAX(id) FROM message WHERE role = 'user'), 0)
			ORDER BY id
		`).all() as unknown as MessageRow[]
		return rows.map(toMessage)
	}

	/** Every photo she sent, newest first (for the gallery). */
	listImages(): CompanionMessage[] {
		const rows = this.db.prepare("SELECT * FROM message WHERE kind = 'image' AND media_path IS NOT NULL ORDER BY id DESC").all() as unknown as MessageRow[]
		return rows.map(toMessage)
	}

	/** Age of the conversation: when it started and how many messages it has. */
	conversationAge(): { startedAt: number | null; messages: number } {
		const row = this.db.prepare('SELECT MIN(created_at) AS started, COUNT(*) AS n FROM message').get() as { started: number | null; n: number }
		return { startedAt: row.started, messages: row.n }
	}

	countUnread(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM message WHERE role = 'companion' AND read_at IS NULL").get() as { n: number }
		return row.n
	}

	markAllRead(): void {
		this.db.prepare("UPDATE message SET read_at = ? WHERE role = 'companion' AND read_at IS NULL").run(Date.now())
	}

	getLatestMemory(): Memory | null {
		const row = this.db.prepare('SELECT upto_message_id, summary FROM memory ORDER BY id DESC LIMIT 1').get() as
			{ upto_message_id: number; summary: string } | undefined
		return row ? { uptoMessageId: row.upto_message_id, summary: row.summary } : null
	}

	insertMemory(uptoMessageId: number, summary: string): void {
		this.db.prepare('INSERT INTO memory (upto_message_id, summary, created_at) VALUES (?, ?, ?)').run(uptoMessageId, summary, Date.now())
	}
}
