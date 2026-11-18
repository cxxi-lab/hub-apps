import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

import type {
	VpnInfo,
	UpdateState,
	WebsiteIntegration,
	CompanionEngineInfo,
	CompanionProfile,
	CompanionMessage,
	CompanionActivity,
	CompanionLogEntry,
	HubbyPackage,
	RestrictedHubbyPackage,
	StoredDocument,
	SystemNotification
} from '@hub/app/platform'

const api = {

	platform: process.platform,
	versions: process.versions,

	ping: (): Promise<string> => ipcRenderer.invoke('ping'),

	getDevMode: (): Promise<boolean> => ipcRenderer.invoke('dev-mode:get'),

	onDevModeChange: (cb: (value: boolean) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, value: boolean) => cb(value)
		ipcRenderer.on('dev-mode:changed', handler)
		return () => ipcRenderer.removeListener('dev-mode:changed', handler)
	},

	notifyAuthState: (authenticated: boolean): void => {
		ipcRenderer.send('auth:state-changed', authenticated)
	},

	getRevealedHubbies: (): Promise<string[]> => ipcRenderer.invoke('revealed-hubbies:get'),

	getDeviceSecret: (name: string): Promise<string | null> => ipcRenderer.invoke('device-secret:get', name),
	setDeviceSecret: (name: string, value: string | null): Promise<void> => ipcRenderer.invoke('device-secret:set', name, value),

	setRevealedHubbies: (ids: string[]): void => {
		ipcRenderer.send('revealed-hubbies:set', ids)
	},

	onRevealedHubbiesChange: (cb: (ids: string[]) => void): (() => void) => subscribe<string[]>('revealed-hubbies:changed', cb),

	onWebviewKey: (cb: (event: { key: string; ctrl: boolean; alt: boolean }) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, payload: { key: string; ctrl: boolean; alt: boolean }) => cb(payload)
		ipcRenderer.on('webview-key', handler)
		return () => ipcRenderer.removeListener('webview-key', handler)
	},

	showMessage: (message: string): Promise<void> => ipcRenderer.invoke('dialog:message', message),

	getMuted: (): Promise<boolean> => ipcRenderer.invoke('audio:muted:get'),

	setMuted: (value: boolean): void => {
		ipcRenderer.send('audio:muted:set', value)
	},
	
	onMutedChange: (cb: (value: boolean) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, value: boolean) => cb(value)
		ipcRenderer.on('audio:muted:changed', handler)
		return () => ipcRenderer.removeListener('audio:muted:changed', handler)
	},

	getVpnStatus: (): Promise<VpnInfo> => ipcRenderer.invoke('vpn:status:get'),

	startVpn: (hubby?: string): Promise<void> => ipcRenderer.invoke('vpn:start', hubby),

	stopVpn: (): Promise<void> => ipcRenderer.invoke('vpn:stop'),

	onVpnStatusChange: (cb: (info: VpnInfo) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, info: VpnInfo) => cb(info)
		ipcRenderer.on('vpn:status:changed', handler)
		return () => ipcRenderer.removeListener('vpn:status:changed', handler)
	},

	openSettings: (target?: string): Promise<void> => ipcRenderer.invoke('settings:open', target),

	setTheme: (mode: 'auto' | 'light' | 'dark', theme: 'light' | 'dark', accent: string): void => {
		ipcRenderer.send('theme:set', mode, theme, accent)
	},

	/** In the Settings window: a screen another window asked for (see openSettings). */
	onHubbyFilesChange: (cb: (hubby: string) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, hubby: string) => cb(hubby)
		ipcRenderer.on('hubbies:dev-changed', handler)
		return () => ipcRenderer.removeListener('hubbies:dev-changed', handler)
	},
	onSettingsGoto: (cb: (target: string) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, target: string) => cb(target)
		ipcRenderer.on('settings:goto', handler)
		return () => ipcRenderer.removeListener('settings:goto', handler)
	},

	/** Opens an OAuth consent page; resolves with the redirect URL it ended on (null: closed). */



	localStore: {
		list: (account: string, hubby: string, scope: string, collection?: string): Promise<StoredDocument[]> => ipcRenderer.invoke('store:list', account, hubby, scope, collection),
		get: (account: string, hubby: string, scope: string, collection: string, id: string): Promise<StoredDocument | null> => ipcRenderer.invoke('store:get', account, hubby, scope, collection, id),
		put: (account: string, hubby: string, scope: string, documents: StoredDocument[]): Promise<void> => ipcRenderer.invoke('store:put', account, hubby, scope, documents),
		delete: (account: string, hubby: string, scope: string, collection: string, id: string): Promise<void> => ipcRenderer.invoke('store:delete', account, hubby, scope, collection, id),
		purge: (account: string, hubby: string, scope: string): Promise<void> => ipcRenderer.invoke('store:purge', account, hubby, scope)
	},

	// the AI models on this device (main: ai/models.ts)
	localModels: {
		state: () => ipcRenderer.invoke('ai-models:state'),
		download: (hubby: string, name: string): Promise<void> => ipcRenderer.invoke('ai-models:download', hubby, name),
		remove: (sha256: string): Promise<void> => ipcRenderer.invoke('ai-models:remove', sha256),
		chooseDirectory: (): Promise<string | null> => ipcRenderer.invoke('ai-models:directory'),
		onChange: (cb: () => void): (() => void) => subscribe<void>('ai-models:changed', () => cb()),
		onFailure: (cb: (failure: { hubby: string, name: string, error: string }) => void): (() => void) => subscribe('ai-models:failed', cb)
	},

	// ai.chat (main: ai/chat.ts): its answer streams as ai:chat:event
	localAi: {
		chat: (id: number, hubby: string, request: unknown) => ipcRenderer.invoke('ai:chat', id, hubby, request),
		abort: (id: number): void => { ipcRenderer.send('ai:chat:abort', id) },
		onEvent: (cb: (event: { id: number, kind: 'delta' | 'reasoning', text: string }) => void): (() => void) => subscribe('ai:chat:event', cb)
	},

	systemNotifications: {
		sync: (items: SystemNotification[]): void => {
			ipcRenderer.send('system-notifications:sync', items)
		},
		onOpen: (cb: (link: string) => void): (() => void) => subscribe<string>('system-notifications:open', cb)
	},

	hubbyStore: {
		list: (): Promise<{ hubbies: HubbyPackage[]; installed: string[] }> => ipcRenderer.invoke('hubbies:list'),
		install: (id: string): Promise<HubbyPackage> => ipcRenderer.invoke('hubbies:install', id),
		uninstall: (id: string): Promise<void> => ipcRenderer.invoke('hubbies:uninstall', id),
		setRestricted: (hubbies: RestrictedHubbyPackage[]): Promise<void> => ipcRenderer.invoke('hubbies:restricted', hubbies),
		pending: (): Promise<string[]> => ipcRenderer.invoke('hubbies:pending'),
		activate: (ids?: string[]): Promise<string[]> => ipcRenderer.invoke('hubbies:activate', ids)
	},

	openAbout: (): Promise<void> => ipcRenderer.invoke('about:open'),

	getAppVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),

	getUpdateState: (): Promise<UpdateState | null> => ipcRenderer.invoke('update:state:get'),

	onUpdateStateChange: (cb: (state: UpdateState) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, state: UpdateState) => cb(state)
		ipcRenderer.on('update:state:changed', handler)
		return () => ipcRenderer.removeListener('update:state:changed', handler)
	},

	installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),

	skipUpdate: (): Promise<void> => ipcRenderer.invoke('update:skip'),

	quitApp: (): Promise<void> => ipcRenderer.invoke('update:quit'),

	replaceVpnConfig: (hubby?: string): Promise<{ ok: boolean; path: string | null; error?: string }> =>
		ipcRenderer.invoke('vpn:config:replace', hubby),
	getVpnConfig: (hubby: string): Promise<{ configured: boolean; endpoint: string | null }> =>
		ipcRenderer.invoke('vpn:config:get', hubby),
	setVpnConfig: (hubby: string, text: string): Promise<{ ok: boolean; error?: string }> =>
		ipcRenderer.invoke('vpn:config:set', hubby, text),
	removeVpnConfig: (hubby: string): Promise<void> => ipcRenderer.invoke('vpn:config:remove', hubby),

	listIntegrations: (): Promise<Array<{ host: string; updatedAt: number }>> =>
		ipcRenderer.invoke('integrations:list'),

	applyIntegration: (payload: { host: string; integration: WebsiteIntegration; updatedAt: number }): Promise<void> =>
		ipcRenderer.invoke('integrations:apply', payload),

	removeIntegration: (host: string): Promise<void> =>
		ipcRenderer.invoke('integrations:remove', host),

	getPlayerBlocklistVersion: (): Promise<string | null> => ipcRenderer.invoke('player-blocklist:version'),

	setPlayerBlocklist: (version: string, hosts: string[]): Promise<void> =>
		ipcRenderer.invoke('player-blocklist:set', { version, hosts }),

	companion: {
		getEngine: (): Promise<CompanionEngineInfo> => ipcRenderer.invoke('companion:engine:get'),

		setEngine: (on: boolean): void => {
			ipcRenderer.send('companion:engine:set', on)
		},

		onEngineChange: (cb: (info: CompanionEngineInfo) => void): (() => void) =>
			subscribe('companion:engine:changed', cb),

		/** Every conversation, the main one first. */
		listConversations: (): Promise<CompanionProfile[]> => ipcRenderer.invoke('companion:conversations:list'),

		getProfile: (conversationId: string): Promise<CompanionProfile> => ipcRenderer.invoke('companion:profile:get', conversationId),

		listMessages: (conversationId: string, opts: { limit: number; beforeId?: number }): Promise<CompanionMessage[]> =>
			ipcRenderer.invoke('companion:messages:list', conversationId, opts),

		send: (conversationId: string, content: string): Promise<CompanionMessage> =>
			ipcRenderer.invoke('companion:send', conversationId, content),

		/** Puts (or removes, with null) the user's emoji on one of her messages. */
		react: (conversationId: string, id: number, emoji: string | null): Promise<CompanionMessage | null> =>
			ipcRenderer.invoke('companion:react', conversationId, id, emoji),

		/** Rewrites her latest reply; resolves to the deleted message ids, or null if not possible. */
		regenerate: (conversationId: string): Promise<number[] | null> => ipcRenderer.invoke('companion:regenerate', conversationId),

		onMessagesDeleted: (cb: (conversationId: string, ids: number[]) => void): (() => void) =>
			subscribe<{ conversationId: string; ids: number[] }>('companion:messages:deleted', p => cb(p.conversationId, p.ids)),

		onMessageUpdate: (cb: (conversationId: string, message: CompanionMessage) => void): (() => void) =>
			subscribe<{ conversationId: string; message: CompanionMessage }>('companion:message:updated', p => cb(p.conversationId, p.message)),

		listImages: (conversationId: string): Promise<CompanionMessage[]> => ipcRenderer.invoke('companion:images:list', conversationId),

		onMessage: (cb: (conversationId: string, message: CompanionMessage) => void): (() => void) =>
			subscribe<{ conversationId: string; message: CompanionMessage }>('companion:message:new', p => cb(p.conversationId, p.message)),

		onActivity: (cb: (conversationId: string, activity: CompanionActivity) => void): (() => void) =>
			subscribe<{ conversationId: string; activity: CompanionActivity }>('companion:activity', p => cb(p.conversationId, p.activity)),

		onError: (cb: (conversationId: string, error: string) => void): (() => void) =>
			subscribe<{ conversationId: string; error: string }>('companion:error', p => cb(p.conversationId, p.error)),

		/** What she is doing right now in that conversation (events only tell the changes). */
		getActivity: (conversationId: string): Promise<CompanionActivity> => ipcRenderer.invoke('companion:activity:get', conversationId),

		/** The conversation's recent activity log, oldest first. */
		listLog: (conversationId: string): Promise<CompanionLogEntry[]> => ipcRenderer.invoke('companion:log:list', conversationId),

		onLog: (cb: (conversationId: string, entry: CompanionLogEntry) => void): (() => void) =>
			subscribe<{ conversationId: string; entry: CompanionLogEntry }>('companion:log', p => cb(p.conversationId, p.entry)),

		/** Unread messages by conversation id. */
		getUnread: (): Promise<Record<string, number>> => ipcRenderer.invoke('companion:unread:get'),

		onUnreadChange: (cb: (counts: Record<string, number>) => void): (() => void) => subscribe('companion:unread:changed', cb),

		markRead: (conversationId: string): void => {
			ipcRenderer.send('companion:read', conversationId)
		}
	}
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
	const handler = (_: IpcRendererEvent, payload: T) => cb(payload)
	ipcRenderer.on(channel, handler)
	return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
