/**
 * Per-model capability tests for the Anthropic API.
 *
 * The two tests below are deliberately opposite in polarity, because the two
 * features carry opposite consequences:
 *
 * - Reasoning effort is an optional tuning knob, so it uses an **allowlist**:
 *   an unrecognised model receives no effort parameter and simply runs at the
 *   provider default. Guessing wrong costs a 400 for no benefit.
 *
 * - Structured output is **required** by extraction, so it uses a **denylist**:
 *   models known not to support it are refused up front with an actionable
 *   message, and anything else is attempted. A custom proxy or a model newer
 *   than this list should get the benefit of the doubt — and if the API really
 *   cannot do it, the request fails loudly rather than silently returning prose.
 */

/**
 * Models with adaptive thinking, and therefore with `output_config.effort`.
 * Sonnet 5+, Haiku 5.5+ and the Opus 4.6+ family qualify; Haiku 4.5 does not --
 * sending it `output_config.effort` is an error, and it has no `adaptive`
 * thinking mode.
 */
const ADAPTIVE_THINKING =
	/^claude-(sonnet-([5-9]|\d\d)|haiku-([5-9]|\d\d)|opus-4-([6-9]|\d\d)|opus-([5-9]|\d\d)|fable-|mythos-)/;

export function supportsAdaptiveThinking(model: string): boolean {
	return ADAPTIVE_THINKING.test(model.trim());
}

/**
 * How a model with adaptive thinking is asked not to think, for *Minimal*.
 *
 * - `disabled`: `thinking: {type: "disabled"}` -- Sonnet 5, Haiku 5.5, Opus 5
 *   and the Opus 4.6-4.8 line, all at their default effort.
 * - `between_tools`: Sonnet 5.5 rejects `disabled` with a 400 and takes
 *   `{type: "between_tools"}` instead. No other model accepts that value.
 * - `none`: thinking cannot be turned off (Opus 5.5, Fable, Mythos); both
 *   `disabled` and a budget are a 400. The lowest setting is effort `low`.
 */
export type ThinkingOff = 'disabled' | 'between_tools' | 'none';

const BETWEEN_TOOLS = /^claude-sonnet-5-5(?!\d)/;
const ALWAYS_THINKS = /^claude-(opus-5-5(?!\d)|fable-|mythos-)/;

export function thinkingOffMode(model: string): ThinkingOff {
	const id = model.trim();
	if (BETWEEN_TOOLS.test(id)) return 'between_tools';
	if (ALWAYS_THINKS.test(id)) return 'none';
	return 'disabled';
}

/**
 * Generations that predate `output_config.format`. Claude 3.x, Claude 2, the
 * original Claude 4.0 models, and the Sonnet 4.x line never gained it.
 */
const NO_STRUCTURED_OUTPUT =
	/^claude-(instant|2|3|3-[0-9]|sonnet-4-[0-6]|opus-4-0|haiku-4-0|haiku-3)\b|^claude-3/;

export function supportsStructuredOutput(model: string): boolean {
	return !NO_STRUCTURED_OUTPUT.test(model.trim());
}
