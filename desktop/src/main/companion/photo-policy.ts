import { conversationLevel, words, type ConversationLevel } from './mood'

// When she sends a photo, and how daring it is, from what the user asked and how charged the
// conversation is. Three photo levels, matching the three conversation levels:
// - normal: dressed;
// - soft: lingerie, half-naked, nothing intimate shown;
// - hard: explicit.
// He gets the level he asks for when it is at most one notch above the conversation (and
// under the relationship stage's cap); further than that, she teases and makes him wait.

export type PhotoLevel = 'normal' | 'soft' | 'hard'

const RANK: Record<PhotoLevel, number> = { normal: 0, soft: 1, hard: 2 }
const FROM_CONVERSATION: Record<ConversationLevel, PhotoLevel> = { normal: 'normal', seduction: 'soft', fantasy: 'hard' }

export const maxLevel = (a: PhotoLevel, b: PhotoLevel): PhotoLevel => (RANK[a] >= RANK[b] ? a : b)
export const minLevel = (a: PhotoLevel, b: PhotoLevel): PhotoLevel => (RANK[a] <= RANK[b] ? a : b)
export const photoLevelOf = (level: ConversationLevel): PhotoLevel => FROM_CONVERSATION[level]

const PHOTO_REQUEST = words("montre|montre-moi|fais voir|fais-moi voir|me faire voir|envoie une photo|envoie-moi une photo|"
	+ "une photo|un selfie|photo de toi|je veux voir|j'aimerais voir|je peux voir|tu me montres", 'iu')
const HARD_REQUEST = words("nude|nudes|photo nue|toute nue|à poil|sans rien|sans vêtements|tes seins|tes tétons|ton cul|ta chatte|"
	+ "ton sexe|écarte|tes fesses nues", 'iu')
const SOFT_REQUEST = words("lingerie|culotte|string|soutif|soutien-gorge|nuisette|sous-vêtements?|en serviette|bikini|maillot|"
	+ "décolleté|tenue sexy|crop[- ]?top|déshabillée?|en petite tenue|tenue légère", 'iu')

// He wants to see an outfit or her whole body: the photo is a full-length mirror selfie.
const FULL_BODY_REQUEST = words("tenue|t'habiller|habillée|habille-toi|tu portes|porter|en entier|de la tête aux pieds|"
	+ "silhouette|ton corps|en pied|ta culotte|ton string|ta lingerie|ta robe|ta jupe", 'iu')

// He wants her seen from behind: the image model is told so firmly, or it turns her three-quarter.
const REAR_VIEW_REQUEST = words("de dos|vue de derrière|de derrière|par derrière|ta chute de reins|tes fesses|ton cul|ton anus", 'iu')

export function wantsRearView(userText: string): boolean {
	return REAR_VIEW_REQUEST.test(userText)
}

// The same, in her own words when she describes a photo she sends.
const OWN_REAR_VIEW = words("de dos|vue de derrière|de derrière|ma chute de reins|mes fesses|mon cul|mon anus|cambrée", 'iu')

export function showsOwnRearView(description: string): boolean {
	return OWN_REAR_VIEW.test(description)
}

export function wantsFullBody(userText: string): boolean {
	return FULL_BODY_REQUEST.test(userText)
}

export type PhotoDecision =
	| { kind: 'none' }
	| { kind: 'tease' }
	| { kind: 'send'; level: PhotoLevel }

/**
 * @param userText   the user's messages since her last reply
 * @param recentText the last few messages of both sides, to read the mood (and the outfit
 *                   being talked about, when he just says "show me")
 * @param cap        most daring level the relationship stage allows
 */
export function photoDecision(userText: string, recentText: string, cap: PhotoLevel = 'hard'): PhotoDecision {
	const hard = HARD_REQUEST.test(userText)
	if (!hard && !PHOTO_REQUEST.test(userText)) return { kind: 'none' }
	const mood = photoLevelOf(conversationLevel(recentText))
	const asked: PhotoLevel = hard ? 'hard' : SOFT_REQUEST.test(userText) || SOFT_REQUEST.test(recentText) ? 'soft' : 'normal'
	// Asking beyond the stage's cap or two notches above the mood: she makes him wait.
	if (RANK[asked] > RANK[cap] || RANK[asked] - RANK[mood] > 1) return { kind: 'tease' }
	return { kind: 'send', level: minLevel(maxLevel(asked, mood), cap) }
}

// What the image model most often gets wrong (point of view, pose, nudity), read from the scene
// written for it, as groups of tagger tags: the photo must show one tag of each group.
const EXPECTATIONS: { match: RegExp; tags: string[] }[] = [
	{ match: /\b(?:rear view|from behind|back to the camera|back view)\b/i, tags: ['from behind', 'ass', 'back'] },
	{ match: /\b(?:lying on (?:her )?back|on her back)\b/i, tags: ['on back'] },
	{ match: /\b(?:lying on (?:her )?(?:stomach|front|belly)|on her stomach)\b/i, tags: ['on stomach'] },
	{ match: /\ball fours\b/i, tags: ['all fours', 'top-down bottom-up'] },
	{ match: /\b(?:kneeling|on (?:her )?knees)\b/i, tags: ['kneeling'] },
	{ match: /\bsquatting\b/i, tags: ['squatting'] },
	{ match: /\bspread(?:ing)? (?:her )?legs\b|\blegs spread\b/i, tags: ['spread legs'] },
	{ match: /\bmirror\b/i, tags: ['mirror', 'reflection'] },
	{ match: /\b(?:nude|naked|topless)\b/i, tags: ['nude', 'completely nude', 'nipples', 'topless', 'pussy'] },
	{ match: /\b(?:lingerie|bra|panties|thong|underwear)\b/i, tags: ['lingerie', 'bra', 'panties', 'thong', 'underwear'] }
]

/** Tag groups the photo of `scene` must match (see EXPECTATIONS). */
export function expectedTags(scene: string): string[][] {
	return EXPECTATIONS.filter(e => e.match.test(scene)).map(e => e.tags)
}

// Tags about her look (fixed by the character LoRA) or the picture itself: nothing to tell her.
const PLAIN_TAGS = new Set(['1girl', 'solo', 'realistic', 'photorealistic', 'photo (medium)', 'black hair', 'short hair', 'bob cut',
	'bangs', 'blunt bangs', 'black eyes', 'brown eyes', 'lips', 'asian', 'looking at viewer', 'medium breasts', 'small breasts',
	'breasts', 'collarbone', 'navel', 'parted lips', 'closed mouth', 'teeth', 'nose', 'lipstick', 'makeup', 'blurry', 'blurry background',
	'depth of field', 'indoors', 'mole', 'eyelashes', 'brown hair', 'straight hair', 'hime cut', 'female focus', 'skinny', 'thighs'])
const MAX_SHOWN_TAGS = 15

/** What the photo shows, from its tags, for her message (English keywords). */
export function shownByTags(tags: string[]): string {
	return tags.filter(t => !PLAIN_TAGS.has(t)).slice(0, MAX_SHOWN_TAGS).join(', ')
}

// Her own words when she describes a photo she sends ("mes fesses", not "tes fesses").
const OWN_HARD = words("nue|toute nue|à poil|sans rien|mes seins|mes tétons|ma chatte|mon sexe|mon cul|mon anus|mes fesses nues|"
	+ "écartée?s?|jambes écartées|cuisses écartées", 'iu')

/**
 * Level of a photo she decides to send herself: what she describes ("en string" is soft), else
 * the mood of the conversation; never above the relationship stage's cap.
 */
export function ownPhotoLevel(description: string, recentText: string, cap: PhotoLevel): PhotoLevel {
	const said: PhotoLevel | null = OWN_HARD.test(description) ? 'hard' : SOFT_REQUEST.test(description) ? 'soft' : null
	return minLevel(said ?? photoLevelOf(conversationLevel(recentText)), cap)
}
