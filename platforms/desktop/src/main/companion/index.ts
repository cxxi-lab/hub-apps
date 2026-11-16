import { app, BrowserWindow, ipcMain, net, protocol } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ActivityEntry, CompanionActivity } from './chat'
import { conversation, conversations, loadedConversations } from './conversations'
import { MAIN_CONVERSATION } from './db'
import { engine } from './engine'
import { limitGpu, releaseGpu } from './gpu'
import { photo } from './photo'
import { voice } from './voice'
import { applyMenu } from '../app/menu'
import { MEDIA_SCHEME } from '../app/schemes'

// Voice messages and photos are served to the app window from the local media dir (MEDIA_SCHEME,
// declared in app/schemes); only the app's own session handles it.

const broadcast = (channel: string, payload: unknown): void => {
	BrowserWindow.getAllWindows().forEach(w => w.webContents.send(channel, payload))
}

/** Unread messages of each conversation, by id. */
const unreadCounts = (): Record<string, number> =>
	Object.fromEntries(conversations().map(c => [c.id, c.chat.store.countUnread()]))

function profileOf(id: string) {
	const { name, label, userName, avatar } = conversation(id).chat.store.profile()
	return { id, name, label: label ?? name, userName, avatar: avatar ?? null }
}

const wired = new WeakSet<object>()

/** A conversation by id, its events forwarded to the app windows tagged with its id. */
function open(id: string) {
	const found = conversation(id)
	const { chat } = found
	if (wired.has(chat)) return found
	wired.add(chat)
	chat.on('message', message => {
		broadcast('companion:message:new', { conversationId: id, message })
		broadcast('companion:unread:changed', unreadCounts())
	})
	chat.on('deleted', (ids: number[]) => {
		broadcast('companion:messages:deleted', { conversationId: id, ids })
		broadcast('companion:unread:changed', unreadCounts())
	})
	chat.on('updated', message => broadcast('companion:message:updated', { conversationId: id, message }))
	chat.on('activity', (activity: CompanionActivity) => broadcast('companion:activity', { conversationId: id, activity }))
	chat.on('error', (error: string) => broadcast('companion:error', { conversationId: id, error }))
	chat.on('log', (entry: ActivityEntry) => broadcast('companion:log', { conversationId: id, entry }))
	return found
}

/**
 * Local AI companion (video hubby, private). Conversation and memory live on this
 * machine only; the engine is switched on/off by the user from the Window menu.
 */
export function setupCompanion(): void {
	protocol.handle(MEDIA_SCHEME, request => {
		// companion-media://<conversation>/<file>: basename only, nothing outside its media dir.
		// A file missing there comes from the main conversation (a profile picture shared by both).
		const url = new URL(request.url)
		const file = path.basename(decodeURIComponent(url.pathname))
		const own = path.join(conversation(url.hostname).chat.store.mediaDir(), file)
		const shared = path.join(conversation(MAIN_CONVERSATION).chat.store.mediaDir(), file)
		return net.fetch(pathToFileURL(existsSync(own) ? own : shared).toString())
	})

	engine.on('status', info => {
		broadcast('companion:engine:changed', info)
		applyMenu()
		if (info.status === 'on') {
			limitGpu()
			voice.start()
			photo.start()
			for (const { id } of conversations()) {
				const { chat, agent } = open(id)
				chat.respondIfPending()
				agent.start()
			}
		}
		else {
			loadedConversations().forEach(c => c.agent.stop())
			voice.stop()
			photo.stop()
			if (info.status === 'off') releaseGpu()
		}
	})

	ipcMain.handle('companion:engine:get', () => engine.getInfo())
	ipcMain.on('companion:engine:set', (_, on: boolean) => void (on ? engine.start() : engine.stop()))
	ipcMain.handle('companion:conversations:list', () => conversations().map(c => profileOf(c.id)))
	ipcMain.handle('companion:profile:get', (_, id: string) => profileOf(id))
	ipcMain.handle('companion:messages:list', (_, id: string, opts: { limit: number; beforeId?: number }) =>
		open(id).chat.store.listMessages(opts.limit, opts.beforeId))
	ipcMain.handle('companion:send', (_, id: string, content: string) => open(id).chat.send(content))
	ipcMain.handle('companion:regenerate', (_, id: string) => open(id).chat.regenerate())
	ipcMain.handle('companion:react', (_, id: string, messageId: number, emoji: string | null) => open(id).chat.react(messageId, emoji))
	ipcMain.handle('companion:images:list', (_, id: string) => open(id).chat.store.listImages())
	ipcMain.handle('companion:unread:get', () => unreadCounts())
	ipcMain.handle('companion:activity:get', (_, id: string) => open(id).chat.currentActivity())
	ipcMain.handle('companion:log:list', (_, id: string) => open(id).chat.activityLog())
	ipcMain.on('companion:read', (_, id: string) => {
		open(id).chat.store.markAllRead()
		broadcast('companion:unread:changed', unreadCounts())
	})

	// The engine holds GPU memory: never leave it running after hub quits.
	app.on('will-quit', () => {
		engine.killChild()
		voice.stop()
		photo.stop()
		if (engine.getInfo().status !== 'off') releaseGpu(true)
	})
}
