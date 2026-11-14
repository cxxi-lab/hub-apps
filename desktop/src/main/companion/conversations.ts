import { Agent } from './agent'
import { Chat } from './chat'
import { ConversationStore, listConversationIds } from './db'

export interface Conversation {
	id: string
	chat: Chat
	agent: Agent
}

const loaded = new Map<string, Conversation>()

const allIdle = (): boolean => [...loaded.values()].every(c => c.chat.isIdle())

/**
 * Every conversation, the main one first. Folders added under conversations/ while the app
 * runs are picked up on the next call.
 */
export function conversations(): Conversation[] {
	return listConversationIds().map(id => {
		let conversation = loaded.get(id)
		if (!conversation) {
			const chat = new Chat(new ConversationStore(id))
			conversation = { id, chat, agent: new Agent(chat, allIdle) }
			loaded.set(id, conversation)
		}
		return conversation
	})
}

export function conversation(id: string): Conversation {
	const found = loaded.get(id) ?? conversations().find(c => c.id === id)
	if (!found) throw new Error(`unknown conversation: ${id}`)
	return found
}

/** Conversations already opened: the ones whose agent may be running. */
export const loadedConversations = (): Conversation[] => [...loaded.values()]
