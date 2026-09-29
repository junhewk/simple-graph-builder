/**
 * Name matching for entity lookup, tuned for Korean.
 *
 * Korean particles attach to words ("인공지능은" is "인공지능" + topic marker) and
 * spacing varies ("머신 러닝" vs "머신러닝"), so exact comparison misses most real
 * queries. Scores are in [0, 1].
 */
import { normalizeKey } from '../types';

/**
 * Bigrams (2-character chunks) of a string, whitespace ignored so spacing
 * variations still match.
 */
export function generateBigrams(text: string): Set<string> {
	const normalized = normalizeKey(text).replace(/\s+/g, '');
	const bigrams = new Set<string>();

	for (let i = 0; i < normalized.length - 1; i++) {
		bigrams.add(normalized.slice(i, i + 2));
	}

	return bigrams;
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
	if (setA.size === 0 && setB.size === 0) return 0;

	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) {
			intersection++;
		}
	}

	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Shortest name that may match *inside* a longer query. Below this, a Latin
 * name like "AI" would match inside "said" or "maintain"; Hangul carries far
 * more information per character, so two syllables are already specific.
 */
function minEmbeddedLength(name: string): number {
	return /[ㄱ-힝一-鿿]/.test(name) ? 2 : 4;
}

/**
 * Score how well `name` matches `query`.
 *
 * 1. Exact match: 1.0
 * 2. Name starts with query: 0.9 + length bonus
 * 3. Name contains query: 0.7 + position bonus
 * 4. Query contains name (e.g. the query is a sentence or has a particle): 0.6–0.7
 * 5. Bigram Jaccard similarity above 0.3: mapped to 0.3–0.6
 */
export function calculateMatchScore(query: string, name: string): number {
	const queryLower = normalizeKey(query).replace(/\s+/g, '');
	const nameLower = normalizeKey(name).replace(/\s+/g, '');
	if (!queryLower || !nameLower) return 0;

	if (nameLower === queryLower) {
		return 1.0;
	}

	// Handles Korean particles: "인공지능은" matches "인공지능"
	if (nameLower.startsWith(queryLower)) {
		const lengthRatio = queryLower.length / nameLower.length;
		return 0.9 + (lengthRatio * 0.09);
	}

	if (nameLower.includes(queryLower)) {
		const position = nameLower.indexOf(queryLower);
		const positionBonus = Math.max(0, 0.1 - (position * 0.01));
		const lengthRatio = queryLower.length / nameLower.length;
		return 0.7 + (lengthRatio * 0.1) + positionBonus;
	}

	if (nameLower.length >= minEmbeddedLength(nameLower) && queryLower.includes(nameLower)) {
		const lengthRatio = nameLower.length / queryLower.length;
		return 0.6 + (lengthRatio * 0.1);
	}

	const queryBigrams = generateBigrams(query);
	const nameBigrams = generateBigrams(name);
	if (queryBigrams.size === 0 || nameBigrams.size === 0) {
		return 0;
	}

	const similarity = jaccardSimilarity(queryBigrams, nameBigrams);
	if (similarity > 0.3) {
		return 0.3 + ((similarity - 0.3) * 0.43);
	}

	return 0;
}

/**
 * Best score of a query against an entity's name and aliases. An alias hit is
 * discounted slightly so the canonical spelling wins a tie.
 */
export function matchEntityName(query: string, name: string, aliases: readonly string[] = []): number {
	let best = calculateMatchScore(query, name);
	for (const alias of aliases) {
		if (best >= 1) break;
		best = Math.max(best, calculateMatchScore(query, alias) * 0.98);
	}
	return best;
}
