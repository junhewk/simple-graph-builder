import { ApiProvider } from '../../types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { ollamaAdapter } from './ollama';
import { openaiCompatibleAdapter } from './openai-compatible';
import { geminiAdapter } from './gemini';
import { deepseekAdapter } from './deepseek';
import { Credentials, ProviderAdapter } from './types';

const ADAPTERS: Record<ApiProvider, ProviderAdapter> = {
	claude: anthropicAdapter,
	openai: openaiAdapter,
	ollama: ollamaAdapter,
	gemini: geminiAdapter,
	deepseek: deepseekAdapter,
};

/**
 * The local-server slot serves two different wire protocols: Ollama's native
 * `/api/chat` and the OpenAI Chat Completions API that llama.cpp's
 * llama-server, LM Studio and vLLM speak. Which one is a per-install setting,
 * so it is resolved from credentials rather than from the provider alone.
 */
export function getAdapter(provider: ApiProvider, creds?: Credentials): ProviderAdapter {
	if (provider === 'ollama' && creds?.localApiStyle === 'openai') {
		return openaiCompatibleAdapter;
	}
	return ADAPTERS[provider];
}

export * from './types';
export * from './effort';
export { runToolLoop } from './tool-loop';
export type { ToolLoopOptions, ToolLoopResult } from './tool-loop';
