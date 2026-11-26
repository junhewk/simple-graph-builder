/**
 * Per-model `thinking_level` values for the Gemini API.
 *
 * Gemini models accept different subsets of minimal / low / medium / high /
 * xhigh, and an unsupported value is a 400. After a 400 the request is retried
 * without any thinking level, so the model runs at its own default -- `high` on
 * Gemini 4 Hydrogen, the slowest and costliest setting for what the user asked
 * to be the cheapest. Both tests are allowlists for that reason: an unknown
 * model gets `low` and `high`, which every current Gemini model accepts.
 */

/** Models that accept `minimal`. Gemini 3.8 Flash and the Gemini 4 line do not. */
const MINIMAL_THINKING = /^gemini-(3\.6-flash|3\.5-flash-lite|3\.1-flash-lite|3-flash)/;

/** Models that accept `xhigh`, above `high`. */
const XHIGH_THINKING = /^gemini-4-(hydrogen|neon)/;

export function supportsMinimalThinking(model: string): boolean {
	return MINIMAL_THINKING.test(model.trim());
}

export function supportsXhighThinking(model: string): boolean {
	return XHIGH_THINKING.test(model.trim());
}
