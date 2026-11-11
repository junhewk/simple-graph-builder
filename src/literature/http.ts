import { requestUrl } from 'obsidian';
import { object, str } from './results';
import type { LiteratureSource } from './types';

export interface LiteratureResponse { status: number; text: string; headers: Record<string, string> }
export interface LiteratureRequest { url: string; headers?: Record<string, string> }
export type LiteratureTransport = (spec: LiteratureRequest) => Promise<LiteratureResponse>;

export class LiteratureHttpError extends Error {
	constructor(message: string, readonly retryable = false, readonly retryAfter = 0) { super(message); }
}

export function cancelled(): Error { return new Error('Search stopped.'); }

/** Serialized per source, including physical requests whose UI deadline has expired. */
export class LiteratureHttp {
	private tails = new Map<LiteratureSource, Promise<unknown>>();
	private lastStart = new Map<LiteratureSource, number>();

	constructor(
		private readonly transport: LiteratureTransport = spec => requestUrl({ ...spec, method: 'GET', throw: false }),
		private readonly wait: (ms: number) => Promise<void> = ms => new Promise(resolve => window.setTimeout(resolve, ms)),
		private readonly now: () => number = Date.now,
		private readonly interval = 1000,
		private readonly deadline = 20000,
	) {}

	async get(source: LiteratureSource, spec: LiteratureRequest, active: () => boolean): Promise<LiteratureResponse> {
		// Both clients use fixed, official endpoints. Never fetch article or arbitrary vault URLs.
		const url = new URL(spec.url);
		if (url.protocol !== 'https:' || (source === 'pubmed' ? url.origin !== 'https://eutils.ncbi.nlm.nih.gov' : url.origin !== 'https://api.openalex.org')) {
			throw new Error('Invalid literature API destination.');
		}
		for (let attempt = 0; ; attempt++) {
			if (!active()) throw cancelled();
			try { return await this.enqueue(source, spec, active); }
			catch (error) {
				if (!active()) throw cancelled();
				if (!(error instanceof LiteratureHttpError) || !error.retryable || attempt >= 2) throw error;
				const delay = error.retryAfter || (1000 * 2 ** attempt + Math.floor(Math.random() * 300));
				// Long quota waits belong in an actionable error, not an invisible retry loop.
				if (delay > 15000) throw error;
				await this.wait(delay);
			}
		}
	}

	private async enqueue(source: LiteratureSource, spec: LiteratureRequest, active: () => boolean): Promise<LiteratureResponse> {
		const previous = this.tails.get(source) ?? Promise.resolve();
		const work = previous.catch(() => undefined).then(async () => {
			if (!active()) throw cancelled();
			const pause = this.interval - (this.now() - (this.lastStart.get(source) ?? -Infinity));
			if (pause > 0) await this.wait(pause);
			if (!active()) throw cancelled();
			this.lastStart.set(source, this.now());
			let response: LiteratureResponse;
			try { response = await this.transport(spec); }
			catch { throw new LiteratureHttpError('Could not reach the literature service. Check your connection and retry.', true); }
			if (!active()) throw cancelled();
			if (response.text.length > 10_000_000) throw new LiteratureHttpError('The service returned an unexpectedly large response.');
			if (response.status >= 400) throw responseError(response, source);
			return response;
		});
		this.tails.set(source, work.catch(() => undefined));
		let timer: number | undefined;
		try {
			return await Promise.race([
				work,
				new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new LiteratureHttpError('The literature request timed out. Retry when the connection is available.')), this.deadline); }),
			]);
		} finally { if (timer !== undefined) window.clearTimeout(timer); }
	}
}

export function parseJson(text: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
		return object(parsed);
	} catch { throw new LiteratureHttpError('The literature service returned an invalid JSON response.'); }
}

function responseError(response: LiteratureResponse, source: LiteratureSource): LiteratureHttpError {
	const headers = Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key.toLowerCase(), value]));
	const rawRetry = headers['retry-after'];
	const seconds = rawRetry ? Number(rawRetry) : NaN;
	const retryAfter = Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(rawRetry ?? '') - Date.now()) || 0;
	let message = '';
	try {
		const data = parseJson(response.text);
		message = str(data.message) ?? str(data.error) ?? str(object(data.error).message) ?? '';
	} catch { /* HTML gateways do not provide useful error text. */ }
	const budget = headers['x-ratelimit-remaining'] === '0' || /budget|quota|plan upgrade|daily limit/i.test(message);
	if ([401, 403].includes(response.status)) {
		return new LiteratureHttpError(`${source === 'pubmed' ? 'PubMed' : 'OpenAlex'} rejected the API key. Check Literature search settings and, for OpenAlex, verify the key's email activation.`);
	}
	if (response.status === 429) {
		return new LiteratureHttpError(budget
			? 'The source’s usage allowance is exhausted. Check its account limits or retry after the allowance resets.'
			: `The source is rate limiting requests.${retryAfter ? ` Retry in ${Math.ceil(retryAfter / 1000)} seconds.` : ' Wait briefly and retry.'}`, !budget, retryAfter);
	}
	if (response.status >= 500) return new LiteratureHttpError(`The literature service is temporarily unavailable (HTTP ${response.status}).`, true);
	return new LiteratureHttpError(`The source rejected the request (HTTP ${response.status}). Check the query and filters.`);
}
