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
	ModuleWindowInfo,
	ModulePackage,
	RestrictedModulePackage,
	StoredDocument,
	StoredFile,
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

	getRevealedModules: (): Promise<string[]> => ipcRenderer.invoke('revealed-modules:get'),

	getDeviceSecret: (name: string): Promise<string | null> => ipcRenderer.invoke('device-secret:get', name),
	setDeviceSecret: (name: string, value: string | null): Promise<void> => ipcRenderer.invoke('device-secret:set', name, value),

	setRevealedModules: (ids: string[]): void => {
		ipcRenderer.send('revealed-modules:set', ids)
	},

	onRevealedModulesChange: (cb: (ids: string[]) => void): (() => void) => subscribe<string[]>('revealed-modules:changed', cb),

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

	startVpn: (): Promise<void> => ipcRenderer.invoke('vpn:start'),

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
	onSettingsGoto: (cb: (target: string) => void): (() => void) => {
		const handler = (_: IpcRendererEvent, target: string) => cb(target)
		ipcRenderer.on('settings:goto', handler)
		return () => ipcRenderer.removeListener('settings:goto', handler)
	},

	/** Opens an OAuth consent page; resolves with the redirect URL it ended on (null: closed). */
	authorizeOAuth: (url: string, redirectUri: string): Promise<string | null> => ipcRenderer.invoke('oauth:authorize', url, redirectUri),

	openModuleWindow: (moduleId: string, windowId: string): Promise<void> => ipcRenderer.invoke('module-window:open', moduleId, windowId),

	registerModuleWindows: (windows: ModuleWindowInfo[]): Promise<void> => ipcRenderer.invoke('module-windows:register', windows),

	localStore: {
		list: (account: string, module: string, scope: string, collection?: string): Promise<StoredDocument[]> => ipcRenderer.invoke('store:list', account, module, scope, collection),
		get: (account: string, module: string, scope: string, collection: string, id: string): Promise<StoredDocument | null> => ipcRenderer.invoke('store:get', account, module, scope, collection, id),
		put: (account: string, module: string, scope: string, documents: StoredDocument[]): Promise<void> => ipcRenderer.invoke('store:put', account, module, scope, documents),
		delete: (account: string, module: string, scope: string, collection: string, id: string): Promise<void> => ipcRenderer.invoke('store:delete', account, module, scope, collection, id),
		purge: (account: string, module: string, scope: string): Promise<void> => ipcRenderer.invoke('store:purge', account, module, scope),
		files: (account: string, module: string, scope: string): Promise<StoredFile[]> => ipcRenderer.invoke('store:files', account, module, scope),
		putFile: (account: string, module: string, scope: string, path: string, body: Uint8Array): Promise<void> => ipcRenderer.invoke('store:file:put', account, module, scope, path, body),
		getFile: (account: string, module: string, scope: string, path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('store:file:get', account, module, scope, path),
		deleteFile: (account: string, module: string, scope: string, path: string): Promise<void> => ipcRenderer.invoke('store:file:delete', account, module, scope, path)
	},

	systemNotifications: {
		sync: (items: SystemNotification[]): void => {
			ipcRenderer.send('system-notifications:sync', items)
		},
		onOpen: (cb: (link: string) => void): (() => void) => subscribe<string>('system-notifications:open', cb)
	},

	moduleStore: {
		list: (): Promise<{ modules: ModulePackage[]; installed: string[] }> => ipcRenderer.invoke('modules:list'),
		install: (id: string): Promise<ModulePackage> => ipcRenderer.invoke('modules:install', id),
		uninstall: (id: string): Promise<void> => ipcRenderer.invoke('modules:uninstall', id),
		setRestricted: (modules: RestrictedModulePackage[]): Promise<void> => ipcRenderer.invoke('modules:restricted', modules),
		pending: (): Promise<string[]> => ipcRenderer.invoke('modules:pending'),
		activate: (): Promise<string[]> => ipcRenderer.invoke('modules:activate')
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

	replaceVpnConfig: (): Promise<{ ok: boolean; path: string | null; error?: string }> =>
		ipcRenderer.invoke('vpn:config:replace'),

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
