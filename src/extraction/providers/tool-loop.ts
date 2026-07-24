import {
	Credentials,
	LlmRequest,
	ProviderAdapter,
	ToolInvocation,
	ToolOutcome,
	Turn,
} from './types';

export interface ToolLoopOptions {
	adapter: ProviderAdapter;
	/** Everything except the conversation, which the loop owns. */
	request: Omit<LlmRequest, 'turns'>;
	creds: Credentials;
	initialUserText: string;
	execute: (call: ToolInvocation) => Promise<unknown> | unknown;
	onProgress?: (status: string) => void;
	maxIterations?: number;
}

export interface ToolLoopResult {
	text: string;
	iterations: number;
	/** True when the loop hit its cap with the model still calling tools. */
	exhausted: boolean;
}

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Provider-agnostic tool-use loop. Every adapter returns the same
 * {text, toolCalls, raw} shape, and `raw` carries whatever that provider needs
 * replayed verbatim, so this loop never has to know which one it is driving.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<ToolLoopResult> {
	const { adapter, request, creds, execute, onProgress } = opts;
	const maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;

	const turns: Turn[] = [{ kind: 'user', text: opts.initialUserText }];

	for (let iteration = 1; iteration <= maxIterations; iteration++) {
		const result = await adapter.complete({ ...request, turns }, creds);

		if (result.toolCalls.length === 0) {
			return { text: result.text, iterations: iteration, exhausted: false };
		}

		turns.push({
			kind: 'assistant',
			text: result.text,
			toolCalls: result.toolCalls,
			raw: result.raw,
		});

		onProgress?.(
			`Searching the graph (${result.toolCalls.map((c) => c.name).join(', ')})…`
		);

		const outcomes: ToolOutcome[] = [];
		for (const call of result.toolCalls) {
			try {
				outcomes.push({
					id: call.id,
					name: call.name,
					result: await execute(call),
				});
			} catch (e) {
				// Hand the failure back rather than dropping the result: a
				// missing tool_result for an issued call is a protocol error on
				// every provider.
				outcomes.push({
					id: call.id,
					name: call.name,
					result: { error: e instanceof Error ? e.message : String(e) },
					isError: true,
				});
			}
		}

		turns.push({ kind: 'tool_results', outcomes });
	}

	return { text: '', iterations: maxIterations, exhausted: true };
}
