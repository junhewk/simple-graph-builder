/**
 * Canonical reasoning-effort levels, mapped onto each provider's own knob:
 * Anthropic `output_config.effort`, OpenAI `reasoning.effort`,
 * Gemini `generation_config.thinking_level`, Ollama `think`.
 *
 * `auto` means "send no effort field at all". It is not cosmetic: the settings
 * UI accepts free-text model IDs, and an unrecognised model must receive no
 * optional parameters rather than a 400.
 */
export const EFFORT_LEVELS = ['auto', 'minimal', 'low', 'medium', 'high', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const DEFAULT_EFFORT: EffortLevel = 'minimal';

export const EFFORT_LABELS: Record<EffortLevel, string> = {
	auto: 'Auto (provider default)',
	minimal: 'Minimal (fastest, cheapest)',
	low: 'Low',
	medium: 'Medium',
	high: 'High',
	max: 'Max (slowest, most thorough)',
};

export function isEffortLevel(value: unknown): value is EffortLevel {
	return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

/**
 * Anthropic bills thinking tokens against `max_tokens`, so a fixed budget plus
 * a high effort level truncates the answer. Scale the ceiling with the effort.
 */
export function defaultMaxOutputTokens(level: EffortLevel): number {
	switch (level) {
		case 'medium':
			return 8192;
		case 'high':
		case 'max':
			return 16384;
		default:
			return 4096;
	}
}
