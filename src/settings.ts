import { Settings } from './types';

/**
 * Models with limited or no tool calling support.
 * These models may not work well with Smart Search.
 */
const LIMITED_TOOL_SUPPORT_PATTERNS = [
	'deepseek-r1',   // Reasoning-focused, limited tool support
	'gemma3',        // Limited tool calling support
	'gemini-2.5-flash-lite', // May have limited support
];

/**
 * Check if the current model configuration supports tool calling.
 * Returns true if the model is expected to work with Smart Search.
 */
export function supportsToolCalling(settings: Settings): boolean {
	const { apiProvider } = settings;

	// Claude, OpenAI always support tool calling
	if (apiProvider === 'claude' || apiProvider === 'openai') {
		return true;
	}

	// Check Gemini model
	if (apiProvider === 'gemini') {
		const model = settings.geminiModel.toLowerCase();
		return !LIMITED_TOOL_SUPPORT_PATTERNS.some(pattern => model.includes(pattern));
	}

	// Check Ollama model
	if (apiProvider === 'ollama') {
		const model = settings.ollamaModel.toLowerCase();
		return !LIMITED_TOOL_SUPPORT_PATTERNS.some(pattern => model.includes(pattern));
	}

	return true;
}

/**
 * Get the name of models with limited tool support for display.
 */
export function getLimitedToolSupportModels(): string[] {
	return ['deepseek-r1:*', 'gemma3:*', 'gemini-2.5-flash-lite'];
}

export const DEFAULT_SETTINGS: Settings = {
	apiProvider: 'claude',
	apiKey: '',
	claudeModel: 'claude-sonnet-4-5-20250929',
	openaiModel: 'gpt-5-mini',
	geminiModel: 'gemini-2.5-flash',
	ollamaModel: 'gpt-oss:20b',
	ollamaHost: 'http://localhost:11434',
	extractionMode: 'simple',
	autoAnalyzeOnSave: false,
	openGraphInMain: false,
};

// Common model options for each provider (for reference in UI)
export const MODEL_OPTIONS = {
	claude: [
		'claude-sonnet-4-5-20250929',
		'claude-haiku-4-5-20251001',
	],
	openai: [
		'gpt-5.1',
		'gpt-5-mini',
		'gpt-5-nano',
		'gpt-4.1',
		'gpt-4.1-mini',
		'gpt-4o',
	],
	gemini: [
		'gemini-3-pro-preview',
		'gemini-2.5-pro',
		'gemini-2.5-flash',
		'gemini-2.5-flash-lite',
		'gemini-2.0-flash'
	],
	ollama: [
		'gpt-oss:20b',
		'gpt-oss:120b',
		'deepseek-r1:8b',
		'deepseek-r1:14b',
		'deepseek-r1:32b',
		'qwen3-coder:30b',
		'gemma3:4b',
		'gemma3:12b',
		'gemma3:27b',
		'qwen3:8b',
		'qwen3:14b',
		'qwen3:32b'
	],
};
