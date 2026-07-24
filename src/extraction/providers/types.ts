import { ApiProvider, LocalApiStyle } from '../../types';
import { EffortLevel } from './effort';

export type JsonSchemaObject = Record<string, unknown>;

export interface ToolInvocation {
	/** Provider-assigned call id, echoed back with the result. */
	id: string;
	name: string;
	/** Already parsed. OpenAI hands this over as a JSON string, Gemini as an object. */
	arguments: unknown;
}

export interface ToolOutcome {
	id: string;
	name: string;
	result: unknown;
	isError?: boolean;
}

/**
 * A provider-neutral conversation turn.
 *
 * `raw` on an assistant turn is the load-bearing part. Every current API
 * requires replaying model-generated content verbatim on the next request —
 * Anthropic's thinking blocks, OpenAI's `reasoning` items under `store:false`,
 * Gemini's `thought` steps, Ollama's whole `message` object. Each adapter
 * stashes its own native payload here and re-emits it; nothing outside the
 * adapter ever inspects it.
 */
export type Turn =
	| { kind: 'user'; text: string }
	| { kind: 'assistant'; text: string; toolCalls: ToolInvocation[]; raw: unknown }
	| { kind: 'tool_results'; outcomes: ToolOutcome[] };

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: JsonSchemaObject;
}

export interface LlmRequest {
	model: string;
	system?: string;
	turns: Turn[];
	tools?: ToolDefinition[];
	/** Structured output. Not set on tool-calling requests. */
	responseSchema?: { name: string; schema: JsonSchemaObject };
	effort: EffortLevel;
	maxOutputTokens: number;
}

export interface Credentials {
	apiKey: string;
	/** Base address of a local LLM server. */
	ollamaHost?: string;
	/** Which API that local server speaks. Defaults to Ollama's native one. */
	localApiStyle?: LocalApiStyle;
}

export interface LlmResult {
	/** All text blocks joined. Empty string is valid when toolCalls is non-empty. */
	text: string;
	toolCalls: ToolInvocation[];
	raw: unknown;
	finishReason?: string;
}

export interface ModelCapabilities {
	tools: boolean;
	structuredOutput: boolean;
	effort: boolean;
}

export interface ProviderAdapter {
	readonly id: ApiProvider;
	complete(req: LlmRequest, creds: Credentials): Promise<LlmResult>;
	/**
	 * Capability tests are allowlists, never denylists: the settings UI accepts
	 * arbitrary custom model IDs, and an unknown one must degrade to sending no
	 * optional parameters rather than erroring.
	 */
	capabilities(model: string): ModelCapabilities;
}
