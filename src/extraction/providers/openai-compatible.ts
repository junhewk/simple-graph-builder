import type { ApiProvider } from '../../types';
import { DowngradeFlags, postJsonWithDowngrade } from './http';
import { createError } from './errors';
import { EffortLevel } from './effort';
import {
	Credentials,
	JsonSchemaObject,
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
 * What differs between servers that speak the OpenAI Chat Completions API.
 *
 * Message, tool and tool-call handling is identical everywhere and lives in the
 * adapter below; the dialect covers where to send, how to authenticate, and the
 * two knobs every vendor extends differently: structured output and reasoning.
 */
export interface ChatCompletionsDialect {
	id: ApiProvider;
	/** Resolves the endpoint, throwing a config error if it cannot. */
	endpoint(creds: Credentials): { url: string; ollamaHost?: string };
	headers(creds: Credentials): Record<string, string> | undefined;
	responseFormat(schema: { name: string; schema: JsonSchemaObject }): unknown;
	/** Only called while the effort hint is still being sent (see postJsonWithDowngrade). */
	applyEffort(body: Record<string, unknown>, effort: EffortLevel): void;
	maxTokens(req: LlmRequest, flags: DowngradeFlags): number;
	/** Extra system text appended after the caller's own system prompt. */
	extraSystem?(req: LlmRequest): string | undefined;
	/** Retries when the server answers with neither text nor tool calls. */
	emptyRetries: number;
	/** Prefix for an error reported inside an HTTP 200 body. */
	errorLabel: string;
	/** Who returned nothing, as in "Empty response from ___." */
	emptyLabel: string;
	capabilities(model: string): ModelCapabilities;
}

export function createChatCompletionsAdapter(dialect: ChatCompletionsDialect): ProviderAdapter {
	return {
		id: dialect.id,

		capabilities(model: string): ModelCapabilities {
			return dialect.capabilities(model);
		},

		async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
			const target = dialect.endpoint(creds);

			for (let attempt = 0; ; attempt++) {
				const data = await postJsonWithDowngrade<ChatCompletionsResponse>((flags) => {
					const body: Record<string, unknown> = {
						model: req.model,
						messages: toMessages(req.turns, joinSystem(req.system, dialect.extraSystem?.(req))),
						stream: false,
						max_tokens: dialect.maxTokens(req, flags),
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
						dialect.applyEffort(body, req.effort);
					}

					if (req.responseSchema) {
						body.response_format = dialect.responseFormat(req.responseSchema);
					}

					return {
						url: target.url,
						provider: dialect.id,
						ollamaHost: target.ollamaHost,
						headers: dialect.headers(creds),
						body,
					};
				});

				// Some builds report failure with HTTP 200 and an error body.
				if (data.error) {
					const message = typeof data.error === 'string' ? data.error : data.error.message;
					throw createError('api_error', `${dialect.errorLabel} error: ${message ?? 'unknown'}`);
				}

				const choice = data.choices?.[0];
				const message = choice?.message ?? {};
				const text = message.content ?? '';

				const toolCalls: ToolInvocation[] = (message.tool_calls ?? []).map((call, index) => ({
					// Not every server assigns ids; synthesise a stable one when absent.
					id: call.id || `${call.function?.name ?? 'tool'}_${index}`,
					name: call.function?.name ?? '',
					arguments: parseArguments(call.function?.arguments),
				}));

				if (!text && toolCalls.length === 0) {
					if (choice?.finish_reason === 'length') {
						throw createError(
							'api_error',
							`${dialect.emptyLabel} ran out of output tokens before answering. ` +
								'Lower the reasoning effort in settings.'
						);
					}
					if (attempt < dialect.emptyRetries) continue;
					throw createError('api_error', `Empty response from ${dialect.emptyLabel}.`);
				}

				return {
					text,
					toolCalls,
					raw: message,
					finishReason: choice?.finish_reason,
				};
			}
		},
	};
}

/**
 * Local servers that speak the OpenAI Chat Completions API: llama.cpp's
 * `llama-server`, LM Studio, vLLM, LiteLLM and similar.
 *
 * Chat Completions rather than the Responses API on purpose. llama-server does
 * expose `/v1/responses`, but only as a shim that rewrites the request into a
 * Chat Completions call, so the Responses-specific fields this plugin relies on
 * (`text.format`, `reasoning.effort`) are not guaranteed to survive the
 * conversion. Chat Completions is the surface these servers actually implement.
 */
const LOCAL_DIALECT: ChatCompletionsDialect = {
	id: 'ollama',

	endpoint(creds) {
		const baseUrl = (creds.ollamaHost || '').replace(/\/+$/, '');
		if (!baseUrl) {
			throw createError('config_error', 'No server address configured for the local LLM server.');
		}
		return {
			// Some servers are mounted at a prefix, so only add /v1 when the
			// configured address does not already include it.
			url: `${baseUrl}${/\/v\d+$/.test(baseUrl) ? '' : '/v1'}/chat/completions`,
			ollamaHost: baseUrl,
		};
	},

	// llama-server needs no key by default; send one only if given.
	headers: (creds) => (creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : undefined),

	responseFormat: (schema) => ({
		type: 'json_schema',
		json_schema: {
			name: schema.name,
			schema: schema.schema,
			strict: false,
		},
	}),

	applyEffort(body, effort) {
		const mapped = toReasoningEffort(effort);
		if (mapped) {
			body.reasoning_effort = mapped;
		}
	},

	maxTokens: (req) => req.maxOutputTokens,
	emptyRetries: 0,
	errorLabel: 'Local server',
	emptyLabel: 'the local LLM server',

	capabilities(): ModelCapabilities {
		// Local servers vary by model and build; the effort downgrade in http.ts
		// covers the mismatch, and a schema rejection is surfaced rather than
		// silently dropped.
		return { tools: true, structuredOutput: true, effort: true };
	},
};

export const openaiCompatibleAdapter = createChatCompletionsAdapter(LOCAL_DIALECT);

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

function joinSystem(system: string | undefined, extra: string | undefined): string | undefined {
	if (!extra) return system;
	return system ? `${system}\n\n${extra}` : extra;
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
