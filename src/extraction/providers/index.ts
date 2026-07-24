import { ApiProvider } from '../../types';
import { anthropicAdapter } from './anthropic';
import { openaiAdapter } from './openai';
import { ollamaAdapter } from './ollama';
import { openaiCompatibleAdapter } from './openai-compatible';
import { geminiAdapter } from './gemini';
import { Credentials, LlmRequest, LlmResult, ProviderAdapter } from './types';

const ADAPTERS: Record<ApiProvider, ProviderAdapter> = {
	claude: anthropicAdapter,
	openai: openaiAdapter,
	ollama: ollamaAdapter,
	gemini: geminiAdapter,
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

/** Single-turn completion with no tools. */
export async function runCompletion(
	provider: ApiProvider,
	request: Omit<LlmRequest, 'turns'>,
	creds: Credentials,
	prompt: string
): Promise<LlmResult> {
	const adapter = ADAPTERS[provider];
	if (!adapter) {
		throw new Error(`No adapter registered for provider: ${provider}`);
	}
	return adapter.complete({ ...request, turns: [{ kind: 'user', text: prompt }] }, creds);
}

export * from './types';
export * from './effort';
export { runToolLoop } from './tool-loop';
export type { ToolLoopOptions, ToolLoopResult } from './tool-loop';
