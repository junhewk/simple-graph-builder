import { postJsonWithDowngrade } from './http';
import { createError } from './errors';
import { EffortLevel } from './effort';
import {
	Credentials,
	LlmRequest,
	LlmResult,
	ModelCapabilities,
	ProviderAdapter,
	ToolInvocation,
	Turn,
} from './types';

interface ChatToolCall {
	id?: string;
	type?: string;
	function: { name: string; arguments: string };
}

interface ChatMessage {
	role?: string;
	content?: string | null;
	tool_calls?: ChatToolCall[];
	reasoning_content?: string;
}

interface ChatCompletionsResponse {
	choices?: { message?: ChatMessage; finish_reason?: string }[];
	error?: { message?: string } | string;
}

/**
 * Adapter for local servers that speak the OpenAI Chat Completions API:
 * llama.cpp's `llama-server`, LM Studio, vLLM, LiteLLM and similar.
 *
 * Chat Completions rather than the Responses API on purpose. llama-server does
 * expose `/v1/responses`, but only as a shim that rewrites the request into a
 * Chat Completions call, so the Responses-specific fields this plugin relies on
 * (`text.format`, `reasoning.effort`) are not guaranteed to survive the
 * conversion. Chat Completions is the surface these servers actually implement.
 */
export const openaiCompatibleAdapter: ProviderAdapter = {
	id: 'ollama',

	capabilities(): ModelCapabilities {
		// Local servers vary by model and build; the effort downgrade in http.ts
		// covers the mismatch, and a schema rejection is surfaced rather than
		// silently dropped.
		return { tools: true, structuredOutput: true, effort: true };
	},

	async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
		const baseUrl = (creds.ollamaHost || '').replace(/\/+$/, '');
		if (!baseUrl) {
			throw createError('config_error', 'No server address configured for the local LLM server.');
		}

		const data = await postJsonWithDowngrade<ChatCompletionsResponse>((flags) => {
			const body: Record<string, unknown> = {
				model: req.model,
				messages: toMessages(req.turns, req.system),
				stream: false,
				max_tokens: req.maxOutputTokens,
			};

			if (req.tools?.length) {
				body.tools = req.tools.map((tool) => ({
					type: 'function',
					function: {
						name: tool.name,
						description: tool.description,
						parameters: tool.parameters,
					},
				}));
			}

			if (flags.effort) {
				const effort = toReasoningEffort(req.effort);
				if (effort) {
					body.reasoning_effort = effort;
				}
			}

			if (req.responseSchema) {
				body.response_format = {
					type: 'json_schema',
					json_schema: {
						name: req.responseSchema.name,
						schema: req.responseSchema.schema,
						strict: false,
					},
				};
			}

			return {
				// Some servers are mounted at a prefix, so only add /v1 when the
				// configured address does not already include it.
				url: `${baseUrl}${/\/v\d+$/.test(baseUrl) ? '' : '/v1'}/chat/completions`,
				provider: 'ollama',
				ollamaHost: baseUrl,
				// llama-server needs no key by default; send one only if given.
				headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : undefined,
				body,
			};
		});

		// Some builds report failure with HTTP 200 and an error body.
		if (data.error) {
			const message = typeof data.error === 'string' ? data.error : data.error.message;
			throw createError('api_error', `Local server error: ${message ?? 'unknown'}`);
		}

		const message = data.choices?.[0]?.message ?? {};
		const text = message.content ?? '';

		const toolCalls: ToolInvocation[] = (message.tool_calls ?? []).map((call, index) => ({
			// Not every server assigns ids; synthesise a stable one when absent.
			id: call.id || `${call.function?.name ?? 'tool'}_${index}`,
			name: call.function?.name ?? '',
			arguments: parseArguments(call.function?.arguments),
		}));

		if (!text && toolCalls.length === 0) {
			throw createError('api_error', 'Empty response from the local LLM server.');
		}

		return {
			text,
			toolCalls,
			raw: message,
			finishReason: data.choices?.[0]?.finish_reason,
		};
	},
};

function toReasoningEffort(effort: EffortLevel): string | undefined {
	switch (effort) {
		case 'auto':
			return undefined;
		case 'minimal':
			return 'none';
		case 'max':
			return 'high';
		default:
			return effort;
	}
}

function toMessages(turns: Turn[], system: string | undefined): unknown[] {
	const messages: unknown[] = [];

	if (system) {
		messages.push({ role: 'system', content: system });
	}

	for (const turn of turns) {
		switch (turn.kind) {
			case 'user':
				messages.push({ role: 'user', content: turn.text });
				break;

			case 'assistant':
				messages.push(
					isChatMessage(turn.raw) ? turn.raw : { role: 'assistant', content: turn.text }
				);
				break;

			case 'tool_results':
				for (const outcome of turn.outcomes) {
					messages.push({
						role: 'tool',
						tool_call_id: outcome.id,
						// Included for servers that pair by name instead of id.
						name: outcome.name,
						content: stringifyResult(outcome.result),
					});
				}
				break;
		}
	}

	return messages;
}

function isChatMessage(raw: unknown): raw is ChatMessage {
	return !!raw && typeof raw === 'object' && 'role' in (raw as Record<string, unknown>);
}

function parseArguments(args: string | undefined): unknown {
	if (!args) return {};
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function stringifyResult(result: unknown): string {
	return typeof result === 'string' ? result : JSON.stringify(result);
}
