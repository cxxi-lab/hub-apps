/**
 * The platform contract: everything the shared UI needs from its host shell.
 *
 * `app/` depends only on this file; each shell provides an implementation
 * (`electron.ts` today, a Capacitor one later). The domain types below are the
 * single source of truth — the Electron preload imports them from here
 * (`@hub/app/platform`) so `window.api` cannot drift from this contract.
 */

export type VpnStatus = 'disabled' | 'starting' | 'connected' | 'error'

export interface VpnInfo {
	status: VpnStatus
	port: number | null
	error: string | null
	endpoint: string | null
}

export type UpdatePhase = 'available' | 'downloading' | 'verifying' | 'installing' | 'error'

export interface UpdateState {
	phase: UpdatePhase
	version: string
	currentVersion: string
	progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null
	error: string | null
}

export interface IntegrationCookie { name: string; value: string }
export interface IntegrationReferer { url: string; cdnHostPattern: string }
export interface WebsiteIntegration {
	cookies?: IntegrationCookie[]
	referer?: IntegrationReferer
}

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

/** A module's window as the host knows it (its component stays in the module). */
export interface ModuleWindowInfo {
	moduleId: string
	id: string
	title: string
	width?: number
	height?: number
	menu?: { label: string, accelerator?: string }
}

/** Unsubscribe handle returned by every `on…` listener. */
export type Unsubscribe = () => void

/**
 * A module as published or installed: its catalogue entry (app/scripts/build-modules.mjs), enough
 * to list it before it is installed.
 */
export interface ModulePackage {
	id: string
	version: string
	/** the SDK range it needs (^x.y.z) */
	sdk: string
	css: boolean
	/** it ships models.json (its collections' models); absent in entries from before the flag */
	models?: boolean
	label: string
	description?: string
	/** its icon's [width, height, svg path] */
	icon?: [number, number, string] | null
	local?: boolean
	requires?: string[]
	requiresCapabilities?: string[]
}

/**
 * A restricted module (offered only to the accounts given it), as the server lists it for this
 * account: its catalogue entry (JSON, with its files) signed alone with the update key, and a
 * signed, expiring URL per file.
 */
export interface RestrictedModulePackage {
	entry: string
	/** base64 */
	signature: string
	urls: Record<string, string>
	/** an entry signed by its publisher's key, not the official one: that key's certificate */
	publisher?: PublisherCertificate
}

/**
 * A key allowed to sign one module's entries (a third party's): `certificate` is the JSON text
 * {"module": <id>, "key": <its Ed25519 public key, SPKI DER, base64>}, `signature` the official
 * key's (base64). Trusted for that module only.
 */
export interface PublisherCertificate {
	certificate: string
	signature: string
}

/** The modules of this device: installed from the server's catalogue (signed), on demand. */
export interface ModuleStoreApi {
	/**
	 * The modules this app can have, one entry each: the installed ones, and the published ones
	 * compatible with this app (the newest). Without the server (VPN down), the installed ones and
	 * the last catalogue read.
	 */
	list(): Promise<{ modules: ModulePackage[]; installed: string[] }>
	/** Installs a module (its newest compatible version), usable at once. Already installed: at once. */
	install(id: string): Promise<ModulePackage>
	/** Removes a module's files from this device (a loaded one stays until the app restarts). */
	uninstall(id: string): Promise<void>
	/**
	 * The restricted modules this account was given (the server's list, renderer side: it needs the
	 * session): the store checks each signature, lists and installs them like the others.
	 */
	setRestricted(modules: RestrictedModulePackage[]): Promise<void>
	/**
	 * The newer versions already downloaded than what runs ("id version"). A module's version is
	 * decided at start; these wait for activate() (or the next start).
	 */
	pending(): Promise<string[]>
	/** Runs them from now on: the app reloads its page right after. Returns what changed. */
	activate(): Promise<string[]>
}

/** One of the app's notifications, as the system shows it. */
export interface SystemNotification {
	id: number
	title: string
	body: string | null
	/** a state's count (null: an event); shown again when it grows */
	count: number | null
	/** where a click leads in the app */
	link: string | null
}

/**
 * The app's notifications shown by the system (desktop: its notification center, the dock marks
 * hub as having some). The page hands over its whole list at each change.
 */
export interface SystemNotificationsApi {
	sync(items: SystemNotification[]): void
	/** a click on one: the app opens its link */
	onOpen(cb: (link: string) => void): Unsubscribe
}

/** A document of a module's store (docs/plan-module-storage.md), local or on the server. */
export interface StoredDocument {
	collection: string
	id: string
	data: unknown
	/** milliseconds: the last write wins */
	updatedAt: number
}

/**
 * The device's base for the modules' data (SQLite: desktop in the main process, Android a plugin),
 * where the local-first sync keeps them (core/sync). Every call names the account (a hash), the
 * module and the scope.
 */
export interface LocalStoreApi {
	list(account: string, module: string, scope: string, collection?: string): Promise<StoredDocument[]>
	get(account: string, module: string, scope: string, collection: string, id: string): Promise<StoredDocument | null>
	put(account: string, module: string, scope: string, documents: StoredDocument[]): Promise<void>
	delete(account: string, module: string, scope: string, collection: string, id: string): Promise<void>
	purge(account: string, module: string, scope: string): Promise<void>
}

/**
 * The app's notifications by push (Android: Firebase Cloud Messaging): the server sends each change,
 * the shell shows it as a system notification, even with the app closed.
 */
export interface PushApi {
	/** Asks the permission to notify (once) and returns this device's token for the server; null: no push. */
	register(): Promise<{ token: string; platform: 'android' } | null>
	/** a notification tapped: the app opens its link */
	onOpen(cb: (link: string) => void): Unsubscribe
}

/**
 * The AI companion. Desktop-only today (local Ollama); a shell without it
 * reports `capabilities.companion === false` and the UI hides the module.
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

/**
 * What the host shell can do. The UI reads these to hide what a shell lacks
 * (e.g. the Capacitor shell has no native windows and no companion engine).
 */
export interface PlatformCapabilities {
	/** AI companion engine (local LLM) */
	companion: boolean
	/** integrated WireGuard tunnel controllable from the UI */
	vpn: boolean
	/** modules hidden behind a reveal shortcut (Privacy) */
	privateMode: boolean
	/** in-app self-update */
	updates: boolean
	/** per-site cookie/referer injection for the embedded browser/player */
	integrations: boolean
	/** embedded <webview> (the integrated browser and the external player) */
	webview: boolean
	/** fullscreen native player (`platform.player`) instead of an embedded <webview> */
	nativePlayer: boolean
	/** separate native windows (Settings/History/About) vs in-app pages */
	nativeWindows: boolean
	/** global audio mute toggle */
	mute: boolean
	/** developer "local server" toggle */
	devMode: boolean
}

/**
 * The host shell, as seen by the shared UI. Method names mirror the Electron
 * preload so the Electron adapter is a thin pass-through; other shells
 * implement what they can and advertise the rest through `capabilities`.
 */
export interface Platform {
	readonly name: 'electron' | 'capacitor'
	/**
	 * Value sent in the `X-Hub-Client` header on the server's cookie-authenticated
	 * auth routes. Must be one of the server's accepted client values
	 * (SecurityController::CLIENT_HEADER_VALUES).
	 */
	readonly client: 'desktop' | 'android'
	readonly capabilities: PlatformCapabilities
	/** Host runtime info for the About screen (OS + engine versions). */
	readonly runtime: { os: string; versions: Record<string, string> }

	ping(): Promise<string>

	getDevMode(): Promise<boolean>
	onDevModeChange(cb: (value: boolean) => void): Unsubscribe

	notifyAuthState(authenticated: boolean): void

	/**
	 * The server just set a new refresh-token cookie (login, refresh: each
	 * refresh revokes the previous token). The shell makes it durable at once,
	 * or an app killed before its cookie store flushes comes back with a revoked
	 * token and a forced re-login.
	 */
	persistSession(): void

	/**
	 * The hidden modules revealed this session (Privacy: their shortcut), shared by the app's
	 * windows; forgotten at restart. Hidden again all at once by Ctrl+Alt+Q.
	 */
	getRevealedModules(): Promise<string[]>
	/**
	 * A secret kept by this device only, encrypted by the system (desktop: the OS keyring through
	 * safeStorage; Android: the Keystore): the account's data key (core/crypto). null: none.
	 */
	getDeviceSecret(name: string): Promise<string | null>
	/** null: forgotten. */
	setDeviceSecret(name: string, value: string | null): Promise<void>

	setRevealedModules(ids: string[]): void
	onRevealedModulesChange(cb: (ids: string[]) => void): Unsubscribe

	onWebviewKey(cb: (event: { key: string; ctrl: boolean; alt: boolean }) => void): Unsubscribe

	showMessage(message: string): Promise<void>

	/**
	 * The theme chosen (`mode`) and shown (`theme`, auto resolved), and the accent colour, for the
	 * shell: desktop, the native theme, the windows' background before they load and the icon in
	 * the accent; Android, the system bars.
	 */
	setTheme(mode: 'auto' | 'light' | 'dark', theme: 'light' | 'dark', accent: string): void

	getMuted(): Promise<boolean>
	setMuted(value: boolean): void
	onMutedChange(cb: (value: boolean) => void): Unsubscribe

	getVpnStatus(): Promise<VpnInfo>
	startVpn(): Promise<void>
	stopVpn(): Promise<void>
	onVpnStatusChange(cb: (info: VpnInfo) => void): Unsubscribe
	replaceVpnConfig(): Promise<{ ok: boolean; path: string | null; error?: string }>

	/** Opens the Settings window, on a screen when given (e.g. 'security'). */
	openSettings(target?: string): Promise<void>
	/** In the Settings window: a screen another window asked for. */
	onSettingsGoto(cb: (target: string) => void): Unsubscribe
	/**
	 * Opens an OAuth consent page in an app window; resolves with the URL the provider redirected to
	 * (`redirectUri` + the code), caught before it loads, or null when the window was closed.
	 */
	authorizeOAuth(url: string, redirectUri: string): Promise<string | null>
	/** Opens a module's window (ModuleManifest.windows), registered beforehand. */
	openModuleWindow(moduleId: string, windowId: string): Promise<void>
	/** The windows of the active modules: what the app menu offers (replaces the previous list). */
	registerModuleWindows(windows: ModuleWindowInfo[]): Promise<void>
	openAbout(): Promise<void>

	getAppVersion(): Promise<string>
	getUpdateState(): Promise<UpdateState | null>
	onUpdateStateChange(cb: (state: UpdateState) => void): Unsubscribe
	installUpdate(): Promise<void>
	skipUpdate(): Promise<void>
	quitApp(): Promise<void>

	listIntegrations(): Promise<Array<{ host: string; updatedAt: number }>>
	applyIntegration(payload: { host: string; integration: WebsiteIntegration; updatedAt: number }): Promise<void>
	removeIntegration(host: string): Promise<void>

	/**
	 * Hosts the embedded browser / video player blocks (ads, trackers), compiled
	 * by the back. The shell persists the list; the version lets the UI skip a
	 * download when it already holds the latest one.
	 */
	getPlayerBlocklistVersion(): Promise<string | null>
	setPlayerBlocklist(version: string, hosts: string[]): Promise<void>

	readonly companion: CompanionApi
	readonly player: NativePlayerApi
	/** null: the shell shows none (Android: they come by push, `push`) */
	readonly systemNotifications: SystemNotificationsApi | null
	/** null: no push (desktop: the open app shows them itself) */
	readonly push: PushApi | null
	/** null: no local store here (Android, for now): a scope kept local isn't reachable on this device */
	readonly localStore: LocalStoreApi | null
	/** null: the modules come from their sources (development), all of them, nothing to install */
	readonly moduleStore: ModuleStoreApi | null
	/**
	 * Where an isolated hubby's frame loads from (its own origin: desktop hubby://<id>/, Android
	 * https://<id>.hubby.localhost/); null where hubbies can't run isolated (yet).
	 */
	hubbyUrl(module: string): string | null
}
