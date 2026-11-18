import type { ComponentType, ReactNode } from 'react'

// Types of the SDK's common API (docs/plan-isolation.md § 2) that the app's sources declare too
// (app/src/platform/types.ts, core/hubby/capabilities/timeline.ts, shared/apiResponse.ts): copied
// here, the SDK being the contract — keep them alike.

export type Unsubscribe = () => void

// --- the API's JSON envelopes ---

export interface SingleResponse<T> { data: T }
export interface ListResponse<T> { data: T[] }
/** Paginated list envelope (data + page metadata). */
export interface PaginatedResponse<T> {
	data: T[]
	meta: { page: number, limit: number, total: number, pages: number }
}

// --- a hubby's definition, in the form of a manifest ---

export interface HubbyNavItem {
	to: string
	label: string
	/** a live label (in the app only; a frame shows `label`) */
	Label?: ComponentType
	section?: string
	icon?: unknown
	home?: boolean
}

export interface HubbyRoute {
	path: string
	Component: ComponentType
	/** kept mounted once visited */
	persistent?: boolean
	/** also answers the paths under it */
	prefix?: boolean
}

/**
 * A hubby's definition (defineHubby), in the form of a manifest: its navigation and its pages; what
 * its hubby.json says (describe(info)) rides along, read by the host from its catalogue entry.
 */
export interface HubbyManifest {
	id: string
	label?: string
	description?: string
	icon?: unknown
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
	supports?: string[]
	navItems: HubbyNavItem[]
	navSections?: Record<string, unknown>
	routes: HubbyRoute[]
	/** contexts around all its pages, outermost first */
	providers?: Array<ComponentType<{ children: ReactNode }>>
	/** in the app only (a frame's settings are a page: hubby.json settingsPage) */
	Settings?: ComponentType
	/** in the app only (between isolated hubbies: their APIs, to come) */
	contributes?: Record<string, unknown>
	pages?: never
}

// --- Planner's calendar (a contribution, in the app only) ---

/** A dated item of a hubby (e.g. a workout session) a calendar shows. */
export interface TimelineItem {
	id: string
	date: Date
	title: string
	hubbyId: string
	href: string
	color?: string
	payload?: unknown
}

// --- the shell (app/src/platform/types.ts) ---

export type CompanionEngineStatus = 'off' | 'starting' | 'on' | 'error'

export interface CompanionEngineInfo {
	status: CompanionEngineStatus
	external: boolean
	error: string | null
}

/** One line of a conversation's activity log: what happened in the background. */
export interface CompanionLogEntry {
	id: number
	at: number
	level: 'info' | 'warn' | 'error'
	text: string
	/** raw text behind the line (reply, notes, scene, tags…) */
	detail?: string
}

/** What the companion is doing right now: writing, recording a voice message or taking a photo. */
export type CompanionActivity = 'typing' | 'recording' | 'photo' | null

export interface CompanionProfile {
	/** conversation id ('main' for the first one) */
	id: string
	name: string
	/** name shown in the app (`name` unless the profile sets another one) */
	label: string
	userName: string
	/** media file of the profile picture */
	avatar: string | null
}

export interface CompanionMessage {
	id: number
	role: 'user' | 'companion'
	kind: 'text' | 'image' | 'audio'
	content: string
	mediaPath: string | null
	createdAt: number
	readAt: number | null
	proactive: boolean
	userReaction: string | null
	userReactionAt: number | null
	companionReaction: string | null
	replyId: number | null
}

/**
 * The AI companion. Desktop-only today (local Ollama); a shell without it
 * reports `capabilities.companion === false` and the UI hides the hubby.
 */
export interface CompanionApi {
	getEngine(): Promise<CompanionEngineInfo>
	setEngine(on: boolean): void
	onEngineChange(cb: (info: CompanionEngineInfo) => void): Unsubscribe
	listConversations(): Promise<CompanionProfile[]>
	getProfile(conversationId: string): Promise<CompanionProfile>
	listMessages(conversationId: string, opts: { limit: number; beforeId?: number }): Promise<CompanionMessage[]>
	send(conversationId: string, content: string): Promise<CompanionMessage>
	react(conversationId: string, id: number, emoji: string | null): Promise<CompanionMessage | null>
	regenerate(conversationId: string): Promise<number[] | null>
	onMessagesDeleted(cb: (conversationId: string, ids: number[]) => void): Unsubscribe
	onMessageUpdate(cb: (conversationId: string, message: CompanionMessage) => void): Unsubscribe
	listImages(conversationId: string): Promise<CompanionMessage[]>
	onMessage(cb: (conversationId: string, message: CompanionMessage) => void): Unsubscribe
	onActivity(cb: (conversationId: string, activity: CompanionActivity) => void): Unsubscribe
	onError(cb: (conversationId: string, error: string) => void): Unsubscribe
	getActivity(conversationId: string): Promise<CompanionActivity>
	listLog(conversationId: string): Promise<CompanionLogEntry[]>
	onLog(cb: (conversationId: string, entry: CompanionLogEntry) => void): Unsubscribe
	getUnread(): Promise<Record<string, number>>
	onUnreadChange(cb: (counts: Record<string, number>) => void): Unsubscribe
	markRead(conversationId: string): void
}

/** What the web layer hands the native player: desktop VideoPlayerModal's webview inputs. */
export interface NativePlayerOptions {
	url: string
	/** Referer header for the first load (embed mode), null for none */
	referrer: string | null
	/** script run once the DOM is ready; the player is ready when its promise settles (null: ready on load) */
	bootstrap: string | null
	/** shown while the page loads */
	poster: string | null
	/** swipe neighbours: whether there is one each way, and its poster (slides in while swiping) */
	hasPrev: boolean
	hasNext: boolean
	prevPoster: string | null
	nextPoster: string | null
	/** posters to fetch ahead (videos further away), so fast swipes find them ready */
	preloadPosters: string[]
}

/** A Font Awesome icon as drawn natively: viewBox size + SVG path data. */
export interface NativeIcon {
	width: number
	height: number
	path: string
}

/** One of the player's actions, behind its gear button. Taps come back through `onAction`. */
export interface NativePlayerAction {
	id: string
	label: string
	icon: NativeIcon
	/** danger: a destructive action awaiting its confirming second tap */
	tone: 'default' | 'danger'
	/** running: shown dimmed, taps ignored */
	busy: boolean
}

/** Overlay over the video (tags, info); tapping it closes it. */
export interface NativePlayerPanel {
	chips?: string[]
	rows?: Array<[label: string, value: string]>
}

/**
 * Fullscreen native player above the app (Capacitor). Stands in for the
 * <webview> of the video player modal on shells without `capabilities.webview`;
 * only reached when `capabilities.nativePlayer` is true.
 */
export interface NativePlayerApi {
	open(options: NativePlayerOptions): Promise<void>
	exec(script: string): Promise<void>
	reload(): Promise<void>
	close(): Promise<void>
	/** the actions behind the gear (the whole list each time), and the icons of the gear and close buttons */
	setActions(actions: NativePlayerAction[], icons: { menu: NativeIcon; close: NativeIcon }): Promise<void>
	showPanel(panel: NativePlayerPanel | null): Promise<void>
	onReady(cb: () => void): Unsubscribe
	onClosed(cb: () => void): Unsubscribe
	onAction(cb: (id: string) => void): Unsubscribe
	/** a swipe went through: the web side switches to that neighbour and opens it */
	onNavigate(cb: (direction: 'prev' | 'next') => void): Unsubscribe
}
