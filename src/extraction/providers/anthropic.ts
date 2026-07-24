import { postJsonWithDowngrade } from './http';
import { createError } from './errors';
import { supportsAdaptiveThinking, supportsStructuredOutput } from './anthropic-models';
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

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

interface AnthropicBlock {
	type: string;
	text?: string;
	id?: string;
	name?: string;
	input?: unknown;
}

interface AnthropicResponse {
	content?: AnthropicBlock[];
	stop_reason?: string;
}

/**
 * Anthropic keeps the Messages API as its current surface, so this adapter is
 * about parameter shape rather than a new endpoint. The per-model divergence is
 * the interesting part: Sonnet 5 takes `thinking` and `output_config.effort`,
 * while Haiku 4.5 errors on both.
 */
export const anthropicAdapter: ProviderAdapter = {
	id: 'claude',

	capabilities(model: string): ModelCapabilities {
		return {
			tools: true,
			structuredOutput: supportsStructuredOutput(model),
			effort: supportsAdaptiveThinking(model),
		};
	},

	async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
		const data = await postJsonWithDowngrade<AnthropicResponse>((flags) => {
			const body: Record<string, unknown> = {
				model: req.model,
				max_tokens: req.maxOutputTokens,
				messages: toMessages(req.turns),
			};

			if (req.system) {
				body.system = req.system;
			}

			if (req.tools?.length) {
				body.tools = req.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					input_schema: tool.parameters,
				}));
			}

			if (flags.effort) {
				applyThinkingAndEffort(body, req.model, req.effort);
			}

			if (req.responseSchema) {
				// Fail loudly rather than silently returning prose: callers that
				// pass a schema depend on the reply conforming to it.
				if (!supportsStructuredOutput(req.model)) {
					throw createError(
						'config_error',
						`${req.model} does not support structured output, which extraction requires. ` +
							'Choose a current Claude model in settings.'
					);
				}
				const outputConfig = (body.output_config ?? {}) as Record<string, unknown>;
				outputConfig.format = {
					type: 'json_schema',
					schema: req.responseSchema.schema,
				};
				body.output_config = outputConfig;
			}

			return {
				url: ENDPOINT,
				provider: 'claude',
				headers: {
					'x-api-key': creds.apiKey,
					'anthropic-version': API_VERSION,
				},
				body,
			};
		});

		const blocks = data.content ?? [];

		// Join every text block. The array can lead with a thinking block, so
		// indexing content[0] is wrong on any adaptive-thinking model.
		const text = blocks
			.filter((b) => b.type === 'text')
			.map((b) => b.text ?? '')
			.join('');

		const toolCalls: ToolInvocation[] = blocks
			.filter((b) => b.type === 'tool_use')
			.map((b) => ({
				id: b.id ?? '',
				name: b.name ?? '',
				arguments: b.input,
			}));

		if (!text && toolCalls.length === 0) {
			throw createError('api_error', 'Empty response from Claude API');
		}

		return {
			text,
			toolCalls,
			// The native block array, replayed verbatim on the next turn so
			// thinking blocks and their signatures survive.
			raw: blocks,
			finishReason: data.stop_reason,
		};
	},
};

/**
 * `thinking` and `output_config.effort` are only valid on models with adaptive
 * thinking. On everything else, omitting `thinking` already means no thinking,
 * and sending `output_config.effort` is an error.
 */
function applyThinkingAndEffort(
	body: Record<string, unknown>,
	model: string,
	effort: EffortLevel
): void {
	if (effort === 'auto' || !supportsAdaptiveThinking(model)) {
		return;
	}

	if (effort === 'minimal') {
		body.thinking = { type: 'disabled' };
		return;
	}

	body.thinking = { type: 'adaptive' };
	body.output_config = { effort };
}

function toMessages(turns: Turn[]): unknown[] {
	const messages: unknown[] = [];

	for (const turn of turns) {
		switch (turn.kind) {
			case 'user':
				messages.push({ role: 'user', content: turn.text });
				break;

			case 'assistant':
				messages.push({
					role: 'assistant',
					// Prefer the native blocks so thinking/tool_use replay intact.
					content: Array.isArray(turn.raw) ? turn.raw : [{ type: 'text', text: turn.text }],
				});
				break;

			case 'tool_results':
				// Every tool_result for a turn must ride in a single user
				// message; splitting them trains the model out of parallel calls.
				messages.push({
					role: 'user',
					content: turn.outcomes.map((outcome) => ({
						type: 'tool_result',
						tool_use_id: outcome.id,
						content: stringifyResult(outcome.result),
						...(outcome.isError ? { is_error: true } : {}),
					})),
				});
				break;
		}
	}

	return messages;
}

function stringifyResult(result: unknown): string {
	return typeof result === 'string' ? result : JSON.stringify(result);
}
