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

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';

/**
 * Steps the model produced. With `store: false` these must be echoed back
 * verbatim on the next request, so they are kept exactly as received rather
 * than reconstructed.
 */
const MODEL_STEP_TYPES = new Set(['thought', 'model_output', 'function_call']);

interface GeminiStep {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	content?: { type?: string; text?: string }[];
}

interface GeminiInteraction {
	status?: string;
	steps?: GeminiStep[];
	output_text?: string;
	error?: { message?: string };
}

/**
 * Gemini moves from `/v1beta/models/{model}:generateContent` to the
 * Interactions API. Three things change beyond the URL:
 *
 * - The API key moves from a `?key=` query parameter to an `x-goog-api-key`
 *   header, so it no longer leaks into logged URLs.
 * - `temperature` / `top_p` / `top_k` / `candidate_count` are gone; thinking
 *   depth is `generation_config.thinking_level`.
 * - Conversation state: with `store: false` the client owns the history, and
 *   every model-generated step — including `thought` steps — must be replayed
 *   verbatim. `store: true` would park note contents on Google's servers, which
 *   is the wrong default for a notes plugin.
 */
export const geminiAdapter: ProviderAdapter = {
	id: 'gemini',

	capabilities(): ModelCapabilities {
		return { tools: true, structuredOutput: true, effort: true };
	},

	async complete(req: LlmRequest, creds: Credentials): Promise<LlmResult> {
		const data = await postJsonWithDowngrade<GeminiInteraction>((flags) => {
			const generationConfig: Record<string, unknown> = {
				max_output_tokens: req.maxOutputTokens,
			};

			if (flags.effort) {
				const thinkingLevel = toThinkingLevel(req.effort);
				if (thinkingLevel) {
					generationConfig.thinking_level = thinkingLevel;
				}
			}

			const body: Record<string, unknown> = {
				model: req.model,
				input: toInput(req.turns),
				generation_config: generationConfig,
				store: false,
			};

			if (req.system) {
				body.system_instruction = req.system;
			}

			if (req.tools?.length) {
				body.tools = req.tools.map((tool) => ({
					type: 'function',
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
				}));
			}

			if (req.responseSchema) {
				body.response_format = {
					type: 'text',
					mime_type: 'application/json',
					schema: req.responseSchema.schema,
				};
			}

			return {
				url: ENDPOINT,
				provider: 'gemini',
				headers: { 'x-goog-api-key': creds.apiKey },
				body,
			};
		});

		// Gemini has historically reported failure with HTTP 200.
		if (data.error) {
			throw createError(
				'api_error',
				`Gemini API error: ${data.error.message || JSON.stringify(data.error)}`
			);
		}

		const steps = data.steps ?? [];

		const text =
			steps
				.filter((step) => step.type === 'model_output')
				.flatMap((step) => step.content ?? [])
				.filter((block) => block.type === 'text')
				.map((block) => block.text ?? '')
				.join('') ||
			data.output_text ||
			'';

		const toolCalls: ToolInvocation[] = steps
			.filter((step) => step.type === 'function_call')
			.map((step) => ({
				id: step.id ?? '',
				name: step.name ?? '',
				// Unlike OpenAI, Gemini hands arguments over already parsed.
				arguments: step.arguments ?? {},
			}));

		if (!text && toolCalls.length === 0) {
			throw createError('api_error', 'Empty response from Gemini API', data.status);
		}

		return {
			text,
			toolCalls,
			raw: steps.filter((step) => MODEL_STEP_TYPES.has(step.type ?? '')),
			finishReason: data.status,
		};
	},
};

/** The enum tops out at `high`, so `max` clamps. */
function toThinkingLevel(effort: EffortLevel): string | undefined {
	switch (effort) {
		case 'auto':
			return undefined;
		case 'max':
			return 'high';
		default:
			return effort;
	}
}

function toInput(turns: Turn[]): unknown[] {
	const input: unknown[] = [];

	for (const turn of turns) {
		switch (turn.kind) {
			case 'user':
				input.push({
					type: 'user_input',
					content: [{ type: 'text', text: turn.text }],
				});
				break;

			case 'assistant':
				if (isUnknownArray(turn.raw)) {
					// Verbatim replay — thought steps carry signatures that are
					// invalidated if the step is rebuilt by hand.
					input.push(...turn.raw);
				} else {
					input.push({
						type: 'model_output',
						content: [{ type: 'text', text: turn.text }],
					});
				}
				break;

			case 'tool_results':
				for (const outcome of turn.outcomes) {
					input.push({
						type: 'function_result',
						name: outcome.name,
						call_id: outcome.id,
						result: [{ type: 'text', text: stringifyResult(outcome.result) }],
					});
				}
				break;
		}
	}

	return input;
}

function stringifyResult(result: unknown): string {
	return typeof result === 'string' ? result : JSON.stringify(result);
}

/** Narrows the opaque replay payload without widening it to `any`. */
function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}
