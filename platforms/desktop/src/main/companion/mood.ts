// Rough reading of how sexual / aroused a piece of conversation is, shared by the rules that
// decide when she sends voice messages and photos.

// \b does not handle accented letters: words are delimited by hand.
// Counting patterns are global; yes/no patterns must not be (a global RegExp.test() is stateful).
export const words = (list: string, flags = 'giu'): RegExp => new RegExp(`(?<!\\p{L})(${list})(?!\\p{L})`, flags)

const EXPLICIT = words('baise\\p{L}*|suce\\p{L}*|lèche\\p{L}*|chatte|queue|bite|mouill\\p{L}*|jouir|jouis|orgasme\\p{L}*|seins?|tétons?|nue|sexe|prends-moi|en moi')
const AROUSAL = words("m+h+|a+h+|o+h+|putain|j'en peux plus|tout de suite|maintenant|viens|encore|plus fort|envie de toi|excitée?")

export function explicitCount(text: string): number {
	return text.match(EXPLICIT)?.length ?? 0
}

/** Explicit words count double, urgency and moans once, a couple of exclamation marks too. */
export function arousalScore(text: string): number {
	const arousal = text.match(AROUSAL)?.length ?? 0
	const exclamations = Math.min(2, text.match(/!/g)?.length ?? 0)
	return explicitCount(text) * 2 + arousal + exclamations
}

// Flirting without explicit words: compliments on her looks, outfits, teasing emojis.
const SEDUCTION = words("sexy|canon|craquante?|à croquer|te manger|te croquer|lingerie|culotte|string|soutif|soutien-gorge|"
	+ "nuisette|crop[- ]?top|déshabill\\p{L}*|embrass\\p{L}*|bisous?|tes lèvres|frissons?|coquin\\p{L}*|chaude?|"
	+ "envie de|désir\\p{L}*|fantasm\\p{L}*|séduis\\p{L}*|séduction|allumeuse|tentante?|irrésistible|😏|😈|🔥|😘|🥵|💋|🫦")

export type ConversationLevel = 'normal' | 'seduction' | 'fantasy'

// Thresholds on the scores above: explicit words or urgency make a fantasy, a few flirty
// words a seduction.
const FANTASY_SCORE = 10
const SEDUCTION_SCORE = 4
const SEDUCTION_WORDS = 2

/** How charged a piece of conversation is: normal chat, flirting, or sexual fantasy. */
export function conversationLevel(text: string): ConversationLevel {
	const score = arousalScore(text)
	if (score >= FANTASY_SCORE) return 'fantasy'
	if (score >= SEDUCTION_SCORE || (text.match(SEDUCTION)?.length ?? 0) >= SEDUCTION_WORDS) return 'seduction'
	return 'normal'
}
