// Small models drift to the masculine when the companion talks about herself
// ("je suis content", "je suis rentré"). Common adjectives and participles after a
// first-person verb are put back in the feminine; anything about the user is left alone.

const WORDS = [
	'content', 'sûr', 'prêt', 'désolé', 'fatigué', 'crevé', 'épuisé', 'curieux', 'heureux', 'déçu', 'surpris',
	'énervé', 'amoureux', 'jaloux', 'excité', 'perdu', 'seul', 'certain', 'ravi', 'ému', 'choqué', 'gêné',
	'motivé', 'occupé', 'pressé', 'stressé', 'rassuré', 'impatient', 'intrigué', 'flatté', 'touché', 'vexé',
	'chaud', 'allongé', 'assis', 'réveillé', 'couché', 'levé', 'rentré', 'arrivé', 'parti', 'allé', 'venu',
	'sorti', 'tombé', 'resté', 'habillé', 'douché', 'endormi', 'impressionné', 'tenté', 'nerveux', 'timide',
	'fier', 'navré', 'sérieux', 'mort', 'nul', 'contrarié', 'blessé', 'senti', 'attirant', 'beau', 'mignon',
	'excitant', 'séduisant', 'bandant'
]

const FIRST_PERSON = String.raw`(?:je suis|j['’]suis|chui|chuis|je me sens|je me suis|j['’]étais|je serais|je serai|je reste|je deviens|`
	+ String.raw`(?:j['’]aimerais|je voudrais|je veux|je préfère|j['’]adore|je dois|je peux|j['’]ai envie d['’])\s+(?:bien\s+|tellement\s+)?être|`
	+ String.raw`tu me trouves|tu me trouverais|me trouver|tu me vois|me voir)`
const ADVERBS = String.raw`(?:(?:trop|tellement|si|vraiment|tout|pas|plus|super|un peu|hyper|très|grave|assez|bien|déjà|encore|enfin|juste|carrément|presque|toujours|jamais|moi-même|aussi)\s+)*`
const MASCULINE = new RegExp(
	String.raw`(?<![\p{L}])(${FIRST_PERSON}\s+${ADVERBS})(${WORDS.join('|')})(?![\p{L}])`,
	'giu'
)

function feminine(word: string): string {
	const lower = word.toLowerCase()
	if (lower.endsWith('e')) return word
	if (lower.endsWith('eux') || lower.endsWith('oux')) return word.slice(0, -1) + 'se'
	if (lower === 'fier') return word.slice(0, -2) + 'ère'
	if (lower === 'nul') return word + 'le'
	if (lower === 'beau') return word.slice(0, -2) + 'lle'
	if (lower === 'mignon') return word + 'ne'
	return word + 'e'
}

// "Je reste ton ami", "je suis juste un ami": the noun, after the same first-person verbs.
const FRIEND = new RegExp(String.raw`(?<![\p{L}])(${FIRST_PERSON}\s+${ADVERBS})(ton|un|ton meilleur|un bon) ami(?![\p{L}])`, 'giu')
const FEMININE_DETERMINER: Record<string, string> = { 'ton': 'ton', 'un': 'une', 'ton meilleur': 'ta meilleure', 'un bon': 'une bonne' }

// A second adjective coordinated with one already in the feminine ("heureuse et un peu jaloux").
const FEMININE_FORMS = WORDS.map(w => feminine(w)).filter((f, i) => f !== WORDS[i])
const COORDINATED = new RegExp(
	String.raw`(?<![\p{L}])((?:${FEMININE_FORMS.join('|')})\s*(?:,\s*|\s+(?:et|mais|ou)\s+)${ADVERBS})(${WORDS.join('|')})(?![\p{L}])`,
	'giu'
)

/** Text with her self-descriptions in the feminine, and whether anything changed. */
export function feminize(text: string): { text: string; changed: boolean } {
	let changed = false
	const fixed = text
		.replace(MASCULINE, (_, prefix: string, word: string) => {
			const fem = feminine(word)
			if (fem !== word) changed = true
			return prefix + fem
		})
		.replace(FRIEND, (_, prefix: string, determiner: string) => {
			changed = true
			return `${prefix}${FEMININE_DETERMINER[determiner.toLowerCase()] ?? determiner} amie`
		})
	// Chains ("contente, ravie et fier"): repeat while a coordinated adjective is fixed.
	let result = fixed
	for (let i = 0; i < 4; i++) {
		const next = result.replace(COORDINATED, (_, prefix: string, word: string) => prefix + feminine(word))
		if (next === result) break
		changed = true
		result = next
	}
	return { text: result, changed }
}
