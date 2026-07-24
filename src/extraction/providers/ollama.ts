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

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';

interface OllamaToolCall {
	function: { name: string; arguments: unknown };
}

interface OllamaMessage {
	role?: string;
	content?: string | null;
	thinking?: string;
	tool_calls?: OllamaToolCall[];
}

interface OllamaChatResponse {
	message?: OllamaMessage;
	done_reason?: string;
}

export function normalizeHost(host: string | undefined): string {
	return (host || DEFAULT_OLLAMA_HOST).replace(/\/+$/, '');
}

/**
 * Ollama moves from the completion-only `/api/generate` to `/api/chat`, which
 * is the only endpoint that can call tools.
 *
 * The previous implementation converted messages to `{role, content}` and
 * dropped `tool_calls` / `tool_call_id` entirely, so the model never saw its
 * own tool results and re-issued the same call until the iteration cap. Pushing
 * the native `message` object back verbatim is what fixes that.
 */
export const ollamaAdapter: ProviderAdapter = {
	id: 'ollama',

	capabilities(): ModelCapabilities {
		// Local models vary; the downgrade retry in http.ts is the real guard.
		return { tools: true, structuredOutput: true, effort: true };
	},

	async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
		const baseUrl = normalizeHost(creds.ollamaHost);

		const data = await postJsonWithDowngrade<OllamaChatResponse>((flags) => {
			const body: Record<string, unknown> = {
				model: req.model,
				messages: toMessages(req.turns, req.system),
				stream: false,
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
				const think = toThink(req.effort);
				if (think !== undefined) {
					body.think = think;
				}
			}

			if (req.responseSchema) {
				body.format = req.responseSchema.schema;
			}

			return { url: `${baseUrl}/api/chat`, provider: 'ollama', ollamaHost: baseUrl, body };
		});

		const message = data.message ?? {};
		const text = message.content ?? '';

		const toolCalls: ToolInvocation[] = (message.tool_calls ?? []).map((call, index) => ({
			// Ollama does not assign call ids, so synthesise a stable one. It is
			// only used to pair the result back up on our side.
			id: `${call.function.name}_${index}`,
			name: call.function.name,
			arguments: parseArguments(call.function.arguments),
		}));

		if (!text && toolCalls.length === 0) {
			throw createError('api_error', 'Empty response from Ollama API');
		}

		return {
			text,
			toolCalls,
			// The whole native message, replayed as the assistant turn so
			// tool_calls and thinking survive the round trip.
			raw: message,
			finishReason: data.done_reason,
		};
	},
};

function toThink(effort: EffortLevel): boolean | string | undefined {
	switch (effort) {
		case 'auto':
			return undefined;
		case 'minimal':
			return false;
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
					isOllamaMessage(turn.raw) ? turn.raw : { role: 'assistant', content: turn.text }
				);
				break;

			case 'tool_results':
				for (const outcome of turn.outcomes) {
					// Ollama pairs results by tool name, not by id.
					messages.push({
						role: 'tool',
						tool_name: outcome.name,
						content: stringifyResult(outcome.result),
					});
				}
				break;
		}
	}

	return messages;
}

function isOllamaMessage(raw: unknown): raw is OllamaMessage {
	return !!raw && typeof raw === 'object' && 'role' in (raw as Record<string, unknown>);
}

function parseArguments(args: unknown): unknown {
	if (typeof args !== 'string') return args ?? {};
	try {
		return JSON.parse(args);
	} catch {
		return {};
	}
}

function stringifyResult(result: unknown): string {
	return typeof result === 'string' ? result : JSON.stringify(result);
}
