import { createError } from './errors';
import { EffortLevel } from './effort';
import { createChatCompletionsAdapter } from './openai-compatible';

const ENDPOINT = 'https://api.deepseek.com/chat/completions';

/**
 * Thinking tokens count against `max_tokens`. The plugin's default ceilings
 * (4096 at low effort) are sized for providers that bill reasoning separately
 * or not at all; with DeepSeek's thinking on they truncate the answer.
 */
const THINKING_MIN_OUTPUT_TOKENS = 32768;

/**
 * DeepSeek's hosted API speaks OpenAI Chat Completions, with two differences
 * that matter here:
 *
 * - `response_format` only accepts `json_object`, not `json_schema`. JSON mode
 *   guarantees parseable JSON but not its shape, so the schema is spelled out
 *   in the system prompt. The reply is still validated against it afterwards
 *   (parseOntologyResponse); without the schema in the prompt, items missing a
 *   required field would be dropped there one by one.
 * - Thinking is on by default and controlled with `thinking.type` and
 *   `reasoning_effort` (none/low/high/max) rather than a single effort knob.
 *
 * With tool calls, every earlier `reasoning_content` must be sent back or the
 * API returns 400. The shared adapter replays the whole assistant message, so
 * that already holds.
 */
export const deepseekAdapter = createChatCompletionsAdapter({
	id: 'deepseek',

	endpoint(creds) {
		if (!creds.apiKey) {
			throw createError('config_error', 'DeepSeek API key not configured. Please set it in settings.');
		}
		return { url: ENDPOINT };
	},

	headers: (creds) => ({ Authorization: `Bearer ${creds.apiKey}` }),

	responseFormat: () => ({ type: 'json_object' }),

	extraSystem(req) {
		if (!req.responseSchema) return undefined;
		return (
			'Respond with a single JSON object and nothing else. ' +
			'It must conform to this JSON Schema:\n' +
			JSON.stringify(req.responseSchema.schema)
		);
	},

	applyEffort(body, effort) {
		if (effort === 'minimal') {
			body.thinking = { type: 'disabled' };
			return;
		}
		const mapped = toReasoningEffort(effort);
		if (mapped) {
			body.reasoning_effort = mapped;
		}
	},

	maxTokens(req, flags) {
		const thinkingOff = flags.effort && req.effort === 'minimal';
		return thinkingOff ? req.maxOutputTokens : Math.max(req.maxOutputTokens, THINKING_MIN_OUTPUT_TOKENS);
	},

	// DeepSeek documents that JSON mode "may occasionally return empty content".
	emptyRetries: 1,
	errorLabel: 'DeepSeek',
	emptyLabel: 'DeepSeek',

	capabilities() {
		return { tools: true, structuredOutput: true, effort: true };
	},
});

function toReasoningEffort(effort: EffortLevel): string | undefined {
	switch (effort) {
		case 'auto':
			return undefined;
		case 'low':
			return 'low';
		case 'max':
			return 'max';
		default:
			// medium and high: DeepSeek has no medium level.
			return 'high';
	}
}
