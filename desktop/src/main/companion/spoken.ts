// Rewrites a French message the way it is actually spoken, so the voice does not sound
// like someone reading: "je suis" → "chuis", "il y a" → "y'a", dropped "ne"…
// Contractions are written phonetically because the TTS reads exactly what it is given.

const RULES: Array<[RegExp, string]> = [
	// Stage directions, emoticons and markdown are not spoken.
	[/\*[^*]+\*/g, ''],
	[/\([^)]*\)/g, ''],
	[/(^|\s)(x+d+|:-?[)(dpo]|;-?\)|<3|\^\^)(?=\s|$|[.,!?])/gi, '$1'],
	[/[_~#>`]/g, ''],
	[/\s*[-–—]\s+/g, ', '],

	// Negation: "ne" is almost never pronounced.
	[/\bje ne sais pas\b/gi, 'chais pas'],
	[/\bje sais pas\b/gi, 'chais pas'],
	[/\bje n'/gi, "j'"],
	[/\btu n'/gi, "t'"],
	[/\b(n'|ne )(?=\S+ (pas|plus|jamais|rien|personne)\b)/gi, ''],

	// Fixed spoken forms.
	[/\bje suis\b/gi, 'chuis'],
	[/\bil y a\b/gi, "y'a"],
	[/\bil n'y a\b/gi, "y'a"],
	[/\btu es\b/gi, "t'es"],
	[/\btu as\b/gi, "t'as"],
	[/\bpeut-être\b/gi, "p't'êt'"],
	[/\bparce que\b/gi, "pasque"],

	// "je" before a consonant: "je pense" → "j'pense". Not before s/z/j/ch, which would merge
	// into a hissing cluster the voice garbles ("je sais" is handled above).
	[/\bje (?=[bcdfgklmnpqrtvw])(?!ch)/gi, "j'"],
	// "me/te/le" before a consonant other than s: "tu me manques" → "tu m'manques".
	// "de" is never elided ("d'se" is heard as "dz"), nor stacked on another apostrophe.
	[/(?<!['’])\b(m|t|l)e (?=[bcdfgklmnpqrtvw])(?!ch)/gi, "$1'"],

	[/\s{2,}/g, ' '],
	[/\s+([.,!?…])/g, '$1']
]

export function toSpokenFrench(text: string): string {
	let out = text
	for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement)
	return out.trim()
}
