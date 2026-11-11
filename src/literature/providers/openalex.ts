import { LiteratureHttp, LiteratureHttpError, parseJson } from '../http';
import { identifiers, object, recordLinks, safeArticleUrl, str } from '../results';
import type { CompiledSearch, LiteratureAdapter, LiteratureCredentials, LiteraturePage, PageToken, PublicationAbstract, PublicationRecord } from '../types';

export class OpenAlexAdapter implements LiteratureAdapter {
	constructor(private readonly http: LiteratureHttp) {}

	async search(spec: CompiledSearch, credentials: LiteratureCredentials, active: () => boolean, next?: PageToken): Promise<LiteraturePage> {
		const page = next?.kind === 'openalex' ? next.page : 1;
		const params = new URLSearchParams({
			'search.title_and_abstract': spec.query, page: String(page), per_page: String(spec.pageSize), rerank: 'false',
			select: 'id,title,ids,doi,publication_year,authorships,primary_location,best_oa_location,abstract_inverted_index,type',
		});
		if (spec.from) params.set('filter', `from_publication_date:${spec.from},to_publication_date:${spec.to}`);
		const url = 'https://api.openalex.org/works?' + params.toString();
		if (url.length > 8190) throw new LiteratureHttpError('The OpenAlex query URL is too long. Remove some expressions.');
		const response = await this.http.get('openalex', { url, headers: credentials.openalex ? { Authorization: `Bearer ${credentials.openalex}` } : undefined }, active);
		const data = parseJson(response.text);
		const count = object(data.meta).count;
		if (!Array.isArray(data.results) || typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
			throw new LiteratureHttpError('OpenAlex returned an invalid results response.');
		}
		const offset = (page - 1) * spec.pageSize;
		const records = data.results.slice(0, Math.min(spec.pageSize, spec.limit - offset))
			.map((raw, index) => normalizeOpenAlex(raw, offset + index + 1)).filter((r): r is PublicationRecord => !!r);
		return {
			records, total: count, warnings: records.length < data.results.length ? ['Some OpenAlex records were invalid or exceeded the result limit.'] : [],
			next: data.results.length && offset + spec.pageSize < Math.min(count, spec.limit) ? { kind: 'openalex', page: page + 1 } : undefined,
		};
	}
}

export function reconstructAbstract(value: unknown): PublicationAbstract {
	if (value === undefined || value === null) return { state: 'missing' };
	if (typeof value !== 'object' || Array.isArray(value)) return { state: 'error', message: 'OpenAlex supplied an invalid abstract index.' };
	const words = new Map<number, string>();
	for (const [word, positions] of Object.entries(object(value))) {
		if (!Array.isArray(positions) || word.length > 5000) return { state: 'error', message: 'OpenAlex supplied an invalid abstract index.' };
		for (const position of positions) {
			if (typeof position !== 'number' || !Number.isInteger(position) || position < 0 || position >= 100000 || words.has(position)) {
				return { state: 'error', message: 'OpenAlex supplied an invalid abstract index.' };
			}
			words.set(position, word);
		}
	}
	if (!words.size) return { state: 'empty' };
	const ordered = [...words.entries()].sort(([a], [b]) => a - b);
	if (ordered.some(([position], index) => position !== index)) return { state: 'error', message: 'OpenAlex supplied an incomplete abstract index.' };
	return { state: 'available', sections: [{ text: ordered.map(([, word]) => word).join(' ') }] };
}

export function normalizeOpenAlex(value: unknown, rank: number): PublicationRecord | null {
	const work = object(value);
	const rawIds = object(work.ids);
	const ids = identifiers({ ...rawIds, doi: work.doi ?? rawIds.doi, openalex: work.id ?? rawIds.openalex });
	if (!ids.openalex) return null;
	const primary = object(work.primary_location);
	const oa = object(work.best_oa_location);
	const links = recordLinks(ids);
	const oaUrl = safeArticleUrl(oa.landing_page_url);
	if (oa.is_oa === true && oaUrl && !/\.pdf(?:[?#]|$)/i.test(oaUrl)) links.unshift({ kind: 'open-access', url: oaUrl, label: 'Open-access article page' });
	const publisherUrl = safeArticleUrl(primary.landing_page_url);
	if (publisherUrl && !/\.pdf(?:[?#]|$)/i.test(publisherUrl) && !links.some(l => l.url === publisherUrl)) {
		links.push({ kind: 'publisher', url: publisherUrl, label: 'Publisher article page' });
	}
	const authorships = Array.isArray(work.authorships) ? work.authorships : undefined;
	return {
		source: 'openalex', sourceRecordId: ids.openalex, sourceRank: rank, retrievedAt: new Date().toISOString(),
		title: str(work.title),
		authors: authorships?.map(author => str(object(object(author).author).display_name) ?? '').filter(Boolean),
		authorsTruncated: authorships?.length === 100,
		year: typeof work.publication_year === 'number' && Number.isInteger(work.publication_year) ? work.publication_year : undefined,
		venue: str(object(primary.source).display_name),
		publicationTypes: typeof work.type === 'string' ? [work.type] : undefined,
		abstract: reconstructAbstract(work.abstract_inverted_index), identifiers: ids,
		accessLinks: links.filter((link, index) => links.findIndex(other => other.url === link.url) === index),
	};
}
