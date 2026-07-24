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

const ENDPOINT = 'https://api.openai.com/v1/responses';

interface OpenAiOutputItem {
	type?: string;
	// message
	content?: { type?: string; text?: string }[];
	// function_call
	call_id?: string;
	name?: string;
	arguments?: string;
}

interface OpenAiResponse {
	output?: OpenAiOutputItem[];
	output_text?: string;
	status?: string;
	incomplete_details?: { reason?: string };
}

/**
 * OpenAI's current surface is the Responses API. Compared to Chat Completions:
 * `input` instead of `messages`, `instructions` instead of a system message,
 * `max_output_tokens` instead of `max_tokens`, flat tool definitions, and
 * `function_call_output` items instead of `role: "tool"` messages. `temperature`
 * is not sent at all — the GPT-5 family rejects any non-default value.
 */
export const openaiAdapter: ProviderAdapter = {
	id: 'openai',

	capabilities(): ModelCapabilities {
		return { tools: true, structuredOutput: true, effort: true };
	},

	async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
		const data = await postJsonWithDowngrade<OpenAiResponse>((flags) => {
			const body: Record<string, unknown> = {
				model: req.model,
				input: toInput(req.turns),
				max_output_tokens: req.maxOutputTokens,
				// The plugin owns conversation history; don't have OpenAI retain it.
				store: false,
			};

			if (req.system) {
				body.instructions = req.system;
			}

			if (flags.effort) {
				const effort = toReasoningEffort(req.effort);
				if (effort) {
					body.reasoning = { effort };
				}
			}

			if (req.tools?.length) {
				body.tools = req.tools.map((tool) => ({
					type: 'function',
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					// Not strict: the graph tools take optional parameters, and
					// strict mode requires every property to appear in `required`.
					strict: false,
				}));
			}

			if (req.responseSchema) {
				body.text = {
					format: {
						type: 'json_schema',
						name: req.responseSchema.name,
						schema: req.responseSchema.schema,
						strict: true,
					},
				};
			}

			return {
				url: ENDPOINT,
				provider: 'openai',
				headers: {
					'Authorization': `Bearer ${creds.apiKey}`,
				},
				body,
			};
		});

		const output = data.output ?? [];

		const text =
			output
				.filter((item) => item.type === 'message')
				.flatMap((item) => item.content ?? [])
				.filter((block) => block.type === 'output_text')
				.map((block) => block.text ?? '')
				.join('') ||
			data.output_text ||
			'';

		const toolCalls: ToolInvocation[] = output
			.filter((item) => item.type === 'function_call')
			.map((item) => ({
				id: item.call_id ?? '',
				name: item.name ?? '',
				arguments: parseArguments(item.arguments),
			}));

		if (!text && toolCalls.length === 0) {
			throw createError(
				'api_error',
				'Empty response from OpenAI API',
				data.incomplete_details?.reason
			);
		}

		return {
			text,
			toolCalls,
			// Replayed verbatim next turn: with store:false the reasoning items
			// have to be resent or the model loses its own chain of thought.
			raw: output,
			finishReason: data.incomplete_details?.reason ?? data.status,
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
			return 'xhigh';
		default:
			return effort;
	}
}

function toInput(turns: Turn[]): unknown[] {
	const input: unknown[] = [];

	for (const turn of turns) {
		switch (turn.kind) {
			case 'user':
				input.push({ role: 'user', content: turn.text });
				break;

			case 'assistant':
				if (isUnknownArray(turn.raw)) {
					// Spread the native output items so reasoning and
					// function_call entries replay unchanged.
					input.push(...turn.raw);
				} else {
					input.push({ role: 'assistant', content: turn.text });
				}
				break;

			case 'tool_results':
				for (const outcome of turn.outcomes) {
					input.push({
						type: 'function_call_output',
						call_id: outcome.id,
						output: stringifyResult(outcome.result),
					});
				}
				break;
		}
	}

	return input;
}

function parseArguments(raw: string | undefined): unknown {
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

function stringifyResult(result: unknown): string {
	return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Narrows the opaque replay payload without widening it to `any`. */
function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}
