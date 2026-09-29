import { ApiProvider, LocalApiStyle, Settings } from '../../types';
import { EffortLevel, defaultMaxOutputTokens } from './effort';

/**
 * Selectable models per provider. The settings UI also accepts a free-text
 * custom model, so this list is a convenience, never a whitelist.
 */
export const MODEL_OPTIONS: Record<ApiProvider, string[]> = {
	claude: [
		'claude-sonnet-5',
		'claude-haiku-4-5',
	],
	openai: [
		'gpt-6-luna',
		'gpt-5.4-mini',
	],
	gemini: [
		'gemini-3.6-flash',
		'gemini-3.5-flash-lite',
	],
	deepseek: [
		'deepseek-flash',
	],
	ollama: [
		'gpt-oss:20b',
		'gpt-oss:120b',
		'qwen3:8b',
		'qwen3:14b',
		'qwen3:32b',
		'qwen3-coder:30b',
		'deepseek-r1:8b',
		'deepseek-r1:14b',
		'deepseek-r1:32b',
		'gemma3:4b',
		'gemma3:12b',
		'gemma3:27b',
	],
};

export interface ResolvedModel {
	provider: ApiProvider;
	model: string;
	apiKey: string;
	ollamaHost: string;
	localApiStyle: LocalApiStyle;
	effort: EffortLevel;
	maxOutputTokens: number;
}

/**
 * The single provider/model/key resolver. Every model call in the plugin is
 * extraction (or its entity-match verification) since Smart Search was removed
 * in 0.7.0.
 */
export function resolveModelConfig(settings: Settings): ResolvedModel {
	const provider: ApiProvider = settings.apiProvider;

	const model = pick(provider, {
		claude: settings.claudeModel,
		openai: settings.openaiModel,
		gemini: settings.geminiModel,
		deepseek: settings.deepseekModel,
		ollama: settings.ollamaModel,
	});

	const effort = settings.extractionEffort;

	return {
		provider,
		model,
		// The provider's own key, falling back to the legacy shared one.
		apiKey: settings.apiKeys?.[provider] || settings.apiKey,
		ollamaHost: settings.ollamaHost,
		localApiStyle: settings.localApiStyle ?? 'ollama',
		effort,
		maxOutputTokens: defaultMaxOutputTokens(effort),
	};
}

function pick(provider: ApiProvider, models: Record<ApiProvider, string>): string {
	return models[provider] || '';
}

/**
 * Pre-flight check used by every analysis entry point. Returns a user-facing
 * error message, or null when extraction can run. Goes through
 * resolveModelConfig so it sees per-provider keys, not just the legacy shared
 * one — checking `settings.apiKey` directly blocked installs that only ever
 * saved a per-provider key.
 */
export function getExtractionConfigError(settings: Settings): string | null {
	const { provider, apiKey, model } = resolveModelConfig(settings);
	if (provider !== 'ollama' && !apiKey) {
		return 'Please configure your API key in settings';
	}
	if (provider === 'ollama' && !model) {
		return 'Ollama model must be set in settings first';
	}
	return null;
}
