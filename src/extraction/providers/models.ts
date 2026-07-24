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
		'gpt-5.6-luna',
		'gpt-5.4-mini',
	],
	gemini: [
		'gemini-3.6-flash',
		'gemini-3.5-flash-lite',
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

/**
 * Local Ollama models known to handle tool calling poorly. Cloud providers are
 * not listed: all six supported cloud models call tools reliably.
 */
const LIMITED_TOOL_SUPPORT_PATTERNS = [
	'deepseek-r1', // Reasoning-focused, limited tool support
	'gemma3',      // Limited tool calling support
];

export function getLimitedToolSupportModels(): string[] {
	return ['deepseek-r1:*', 'gemma3:*'];
}

export type ModelPurpose = 'extraction' | 'smartSearch';

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
 * The single provider/model/key resolver. Replaces the three near-duplicate
 * lookup blocks that previously lived in llm-client.ts and settings.ts and had
 * already drifted apart (Smart Search used to send the extraction provider's
 * API key regardless of which provider it was actually calling).
 */
export function resolveModelConfig(settings: Settings, purpose: ModelPurpose): ResolvedModel {
	const useSeparate = purpose === 'smartSearch' && settings.useSeparateSmartSearchModel;

	const provider: ApiProvider = useSeparate ? settings.smartSearchProvider : settings.apiProvider;

	const model = useSeparate
		? pick(provider, {
			claude: settings.smartSearchClaudeModel,
			openai: settings.smartSearchOpenaiModel,
			gemini: settings.smartSearchGeminiModel,
			ollama: settings.smartSearchOllamaModel,
		})
		: pick(provider, {
			claude: settings.claudeModel,
			openai: settings.openaiModel,
			gemini: settings.geminiModel,
			ollama: settings.ollamaModel,
		});

	const effort = purpose === 'smartSearch' ? settings.smartSearchEffort : settings.extractionEffort;

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
 * Whether the effective Smart Search model can call tools at all. Smart Search
 * is useless without them — it can only answer by querying the graph.
 */
export function supportsToolCalling(settings: Settings): boolean {
	const { provider, model } = resolveModelConfig(settings, 'smartSearch');
	if (provider !== 'ollama') {
		return true;
	}
	const lower = model.toLowerCase();
	return !LIMITED_TOOL_SUPPORT_PATTERNS.some((pattern) => lower.includes(pattern));
}
