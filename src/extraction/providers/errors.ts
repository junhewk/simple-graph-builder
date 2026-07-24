import { ApiProvider, EmbeddingProvider } from '../../types';

/**
 * Any provider the plugin talks to, whether for completions or embeddings.
 */
export type ProviderId = ApiProvider | EmbeddingProvider;

export interface ExtractionError {
	type: 'api_error' | 'parse_error' | 'config_error' | 'rate_limit';
	message: string;
	details?: string;
}

/** Extra context attached to errors raised from an HTTP response. */
export interface HttpErrorContext {
	status?: number;
	retryAfterSeconds?: number;
}

export type TypedError = Error & ExtractionError & HttpErrorContext;

export function createError(
	type: ExtractionError['type'],
	message: string,
	details?: string
): TypedError {
	const error = new Error(message) as TypedError;
	error.type = type;
	error.details = details;
	return error;
}

export function isExtractionError(e: unknown): e is TypedError {
	return e instanceof Error && 'type' in e;
}

/**
 * Transport-level failures reject before any HTTP response exists, so there is
 * no status to branch on — only the message.
 */
const TRANSPORT_FAILURE =
	/ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ERR_CONNECTION|Failed to fetch|net::/i;

export function isTransportFailure(e: unknown): boolean {
	return e instanceof Error && TRANSPORT_FAILURE.test(e.message);
}

/**
 * Last-resort mapping for errors that did not come from `postJson` — mostly
 * transport failures and unexpected throws. HTTP responses are turned into
 * typed errors at the point of the request, where the provider's own error
 * body is still available.
 */
export function handleApiError(e: unknown, provider: ProviderId, ollamaHost?: string): Error {
	if (isExtractionError(e)) {
		return e;
	}

	if (isTransportFailure(e)) {
		if (provider === 'ollama') {
			return createError(
				'api_error',
				`Cannot reach Ollama at ${ollamaHost ?? 'the configured host'}. Is it running?`
			);
		}
		return createError('api_error', `Could not reach the ${provider} API. Check your connection.`);
	}

	const message = e instanceof Error ? e.message : String(e);
	return createError('api_error', `Failed to call ${provider} API: ${message || 'Unknown error'}`);
}
