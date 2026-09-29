/**
 * Tokenizer shared by the note index, the entity index and query parsing.
 *
 * Latin-script text splits into words. Hangul and CJK runs become overlapping
 * character bigrams instead: Korean particles attach to the word ("인공지능은"),
 * so whole-word tokens would never match the bare noun, while the bigrams
 * 인공/공지/지능 are shared by both spellings. A one-character run is kept as is.
 */

const CJK_CHAR = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-힯ힰ-퟿豈-﫿]/;
const WORD_RUN = /[\p{L}\p{N}]+/gu;

/** Function words that would otherwise dominate BM25 on English prose. */
const STOPWORDS = new Set([
	'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from', 'has', 'have',
	'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'their', 'this',
	'to', 'was', 'were', 'which', 'with',
]);

export function normalizeText(text: string): string {
	return text.normalize('NFC').toLowerCase();
}

/**
 * Split a run of letters/digits into alternating CJK and non-CJK pieces:
 * "gpt4모델을" -> ["gpt4", "모델을"].
 */
function splitScripts(run: string): { text: string; cjk: boolean }[] {
	const pieces: { text: string; cjk: boolean }[] = [];
	let current = '';
	let currentCjk = false;
	for (const ch of run) {
		const cjk = CJK_CHAR.test(ch);
		if (current && cjk !== currentCjk) {
			pieces.push({ text: current, cjk: currentCjk });
			current = '';
		}
		current += ch;
		currentCjk = cjk;
	}
	if (current) pieces.push({ text: current, cjk: currentCjk });
	return pieces;
}

function pushPiece(out: string[], piece: { text: string; cjk: boolean }): void {
	if (!piece.cjk) {
		if (!STOPWORDS.has(piece.text)) out.push(piece.text);
		return;
	}
	const chars = Array.from(piece.text);
	if (chars.length === 1) {
		out.push(chars[0]);
		return;
	}
	for (let i = 0; i < chars.length - 1; i++) {
		out.push(chars[i] + chars[i + 1]);
	}
}

/** All tokens in document order, duplicates kept (term frequency matters). */
export function tokenize(text: string): string[] {
	const out: string[] = [];
	const normalized = normalizeText(text);
	for (const match of normalized.matchAll(WORD_RUN)) {
		for (const piece of splitScripts(match[0])) pushPiece(out, piece);
	}
	return out;
}

/**
 * The user-visible words of a query, for explaining matches. Each carries its
 * own tokens so a result can report which words it matched.
 */
export function queryWords(query: string): { word: string; tokens: string[] }[] {
	const words: { word: string; tokens: string[] }[] = [];
	const seen = new Set<string>();
	for (const match of normalizeText(query).matchAll(WORD_RUN)) {
		const word = match[0];
		if (seen.has(word)) continue;
		const tokens = tokenize(word);
		if (tokens.length === 0) continue;
		seen.add(word);
		words.push({ word, tokens: [...new Set(tokens)] });
	}
	return words;
}
