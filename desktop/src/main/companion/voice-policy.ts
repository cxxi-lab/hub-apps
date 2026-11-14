import { arousalScore, explicitCount, words } from './mood'
import type { VoiceRegister } from './voice'

// When a reply is sent as a voice message instead of text. Decided here rather than by the
// model: asking a small LLM to tag its own replies pulls it out of character.
//
// - casual chat: some long replies (she has a lot to say and can't be bothered to type)
//   become voice messages, but not right after another one;
// - sexual chat: only when she is very aroused, in the "excited" register;
// - never in role-play scenes (*actions*): they are together, nobody sends a voice note;
// - always when the user asks for one ("fais-moi un vocal", "j'aimerais entendre ta voix").

const LONG_REPLY_CHARS = 400
const LONG_REPLY_VOICE_PROBABILITY = 0.4
const EXCITED_SCORE = 8

const SCENE_ACTION = /\*[^*\n]{3,}\*/

// Requests for her voice, explicit or implied. A negation ("pas de vocal") cancels them.
const VOICE_REQUEST = words("vocal|vocaux|audio|enregistre-toi|ta voix|t'entendre|entendre ta|écouter ta", 'iu')
const VOICE_REFUSAL = words("pas de vocal|pas de vocaux|pas d'audio|pas besoin de vocal|sans vocal", 'iu')

export function voiceRequested(userText: string): boolean {
	return VOICE_REQUEST.test(userText) && !VOICE_REFUSAL.test(userText)
}

/** @param recentVoice she already sent a voice message among the last few messages */
export function voiceRegisterFor(reply: string, requested: boolean, recentVoice: boolean): VoiceRegister | null {
	const score = arousalScore(reply)
	if (requested) return score >= EXCITED_SCORE ? 'excited' : 'normal'
	if (recentVoice || SCENE_ACTION.test(reply)) return null
	if (explicitCount(reply) > 0) return score >= EXCITED_SCORE ? 'excited' : null
	if (reply.length >= LONG_REPLY_CHARS && Math.random() < LONG_REPLY_VOICE_PROBABILITY) return 'normal'
	return null
}
