import { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
	apiProvider: 'claude',
	apiKey: '',
	claudeModel: 'claude-sonnet-4-5-20250929',
	openaiModel: 'gpt-5-mini',
	geminiModel: 'gemini-2.5-flash',
	ollamaModel: 'gpt-oss:20b',
	ollamaHost: 'http://localhost:11434',
	keywords: [],
	autoAnalyzeOnSave: false,
};

// Common model options for each provider (for reference in UI)
export const MODEL_OPTIONS = {
	claude: [
		'claude-sonnet-4-5-20250929',
		'claude-4-5-haiku-20251001',
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
