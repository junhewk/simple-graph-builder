import { requestUrl } from 'obsidian';
import {
	ProviderId,
	TypedError,
	createError,
	handleApiError,
} from './errors';

export interface PostJsonSpec {
	url: string;
	headers?: Record<string, string>;
	body: unknown;
	provider: ProviderId;
	/** Only used to make "is Ollama running?" errors actionable. */
	ollamaHost?: string;
}

/**
 * The single HTTP entry point for every provider call.
 *
 * Three things here are load-bearing and easy to get wrong:
 *
 * 1. `throw: false` — without it Obsidian rejects with a bare Error that
 *    carries no status, so nothing downstream can tell a 401 from a 500.
 * 2. We never touch `res.json`. It is a getter that runs JSON.parse and throws
 *    on non-JSON, which is exactly what error paths hand back: Ollama's plain
 *    text, a proxy's HTML login page, a gateway's 502.
 * 3. `requestUrl` still rejects on transport failure (DNS, ECONNREFUSED) even
 *    with `throw: false`, so the try/catch is not redundant.
 */
export async function postJson<T = unknown>(spec: PostJsonSpec): Promise<T> {
	const { url, headers, body, provider, ollamaHost } = spec;

	let status: number;
	let rawText: string;
	let responseHeaders: Record<string, string>;

	try {
		const res = await requestUrl({
			url,
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...headers },
			body: JSON.stringify(body),
			throw: false,
		});
		status = res.status;
		rawText = res.text;
		responseHeaders = res.headers ?? {};
	} catch (e) {
		throw handleApiError(e, provider, ollamaHost);
	}

	const parsed = safeParse(rawText);

	if (status >= 400) {
		throw buildHttpError(provider, status, parsed, rawText, responseHeaders);
	}

	if (parsed === undefined) {
		throw createError(
			'parse_error',
			`${provider} API returned a non-JSON response.`,
			rawText.slice(0, 200)
		);
	}

	return parsed as T;
}

/**
 * Which optional features are included in an attempt.
 *
 * Structured output is deliberately absent. It is the contract extraction is
 * built on, not a nice-to-have — see `postJsonWithDowngrade` below.
 */
export interface DowngradeFlags {
	effort: boolean;
}

const EFFORT_REJECTED = /effort|output_config|thinking_level|thinking|reasoning|\bthink\b|verbosity/i;
const SCHEMA_REJECTED = /schema|json_schema|response_format|structured|\bformat\b/i;

/**
 * Send a request, dropping the reasoning-effort hint if the provider rejects it.
 *
 * The settings UI accepts free-text model IDs, so the per-model allowlists will
 * eventually be wrong for somebody's custom endpoint or local Ollama build.
 * Effort is a tuning knob, so retrying without it is strictly better than
 * failing.
 *
 * **Structured output is never downgraded.** Extraction depends on a
 * schema-shaped reply; silently retrying without one would swap a loud failure
 * for a quietly degraded knowledge graph, which is far worse. A schema
 * rejection is re-thrown as an actionable config error telling the user to pick
 * a model that supports it.
 */
export async function postJsonWithDowngrade<T = unknown>(
	build: (flags: DowngradeFlags) => PostJsonSpec
): Promise<T> {
	const flags: DowngradeFlags = { effort: true };

	for (let attempt = 0; ; attempt++) {
		try {
			return await postJson<T>(build(flags));
		} catch (e) {
			const status = (e as TypedError).status;
			if (attempt >= 1 || status !== 400) {
				throw e;
			}

			const text = `${(e as TypedError).details ?? ''} ${(e as Error).message ?? ''}`;
			const spec = build(flags);
			const requestedSchema = hasStructuredOutput(spec.body);

			// Check schema first: an "unknown field response_format" message can
			// also match the effort pattern, and dropping effort would leave the
			// real problem in place for a second, identical failure.
			if (requestedSchema && SCHEMA_REJECTED.test(text)) {
				throw createError(
					'config_error',
					`${spec.provider} rejected structured output for this model. ` +
						'Extraction requires a model that supports JSON schema output — ' +
						'choose a different model in settings.',
					text.trim()
				);
			}

			if (flags.effort && EFFORT_REJECTED.test(text)) {
				console.warn(
					'[simple-graph-builder] Provider rejected the reasoning-effort parameter; retrying without it.',
					text
				);
				flags.effort = false;
				continue;
			}

			throw e;
		}
	}
}

/** True when the built request carries a structured-output directive. */
function hasStructuredOutput(body: unknown): boolean {
	if (!body || typeof body !== 'object') return false;
	const b = body as Record<string, unknown>;
	return (
		// Ollama                       Gemini                  OpenAI
		b.format !== undefined ||
		b.response_format !== undefined ||
		(b.text as Record<string, unknown> | undefined)?.format !== undefined ||
		// Anthropic
		(b.output_config as Record<string, unknown> | undefined)?.format !== undefined
	);
}

function safeParse(text: string): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function buildHttpError(
	provider: ProviderId,
	status: number,
	parsed: unknown,
	rawText: string,
	headers: Record<string, string>
): TypedError {
	const detail = extractProviderMessage(provider, parsed) ?? rawText.slice(0, 300);

	let error: TypedError;
	if (status === 401 || status === 403) {
		error = createError(
			'api_error',
			`Invalid ${provider} API key. Please check your settings.`,
			detail
		);
	} else if (status === 429) {
		const retryAfter = parseRetryAfter(headers);
		error = createError(
			'rate_limit',
			retryAfter
				? `Rate limit exceeded for ${provider}. Retry in ${retryAfter}s.`
				: `Rate limit exceeded for ${provider}. Please wait and try again.`,
			detail
		);
		error.retryAfterSeconds = retryAfter;
	} else if (status >= 500) {
		error = createError(
			'api_error',
			`${provider} API server error (${status}). Please try again later.`,
			detail
		);
	} else {
		// 400 and friends: the provider's own message is the useful part.
		error = createError('api_error', `${provider} API rejected the request: ${detail}`, detail);
	}

	error.status = status;
	return error;
}

/**
 * Each provider nests its human-readable message somewhere different.
 * Gemini is the odd one out twice over: it can also return `{error: ...}` with
 * HTTP 200, which callers check separately via `extractProviderMessage`.
 */
export function extractProviderMessage(provider: ProviderId, parsed: unknown): string | undefined {
	if (!parsed || typeof parsed !== 'object') return undefined;
	const body = parsed as Record<string, unknown>;

	// Ollama: {error: "model 'foo' not found"}
	if (typeof body.error === 'string') {
		return body.error;
	}

	// Anthropic {error:{type,message}}, OpenAI {error:{message,type,code}},
	// Gemini {error:{code,message,status}} — same shape, different discriminators.
	const err = body.error;
	if (err && typeof err === 'object') {
		const message = (err as Record<string, unknown>).message;
		if (typeof message === 'string') return message;
	}

	// Some Gemini endpoints wrap the error in a single-element array.
	if (Array.isArray(parsed) && parsed.length > 0) {
		return extractProviderMessage(provider, parsed[0]);
	}

	return undefined;
}

function parseRetryAfter(headers: Record<string, string>): number | undefined {
	const raw = headers['retry-after'] ?? headers['Retry-After'];
	if (!raw) return undefined;
	const seconds = Number(raw);
	return Number.isFinite(seconds) ? seconds : undefined;
}
