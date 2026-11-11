import { AccessLink, PublicationIds, PublicationRecord } from './types';

export function object(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function str(value: unknown): string | undefined {
	return typeof value === 'string' ? value.trim() : undefined;
}

export function normalizeDoi(value: unknown): string | undefined {
	let text = str(value)?.replace(/^doi:\s*/i, '');
	if (text && /^https?:\/\/(?:dx\.)?doi\.org\//i.test(text)) {
		try { text = decodeURIComponent(new URL(text).pathname.slice(1)); } catch { return undefined; }
	}
	return text && /^10\.\d{4,9}\/\S+$/i.test(text) ? text.toLowerCase() : undefined;
}

export function identifiers(value: unknown): PublicationIds {
	const data = object(value);
	const uid = str(data.uid) ?? '';
	const pmidValue = typeof data.pmid === 'number' && Number.isSafeInteger(data.pmid) && data.pmid > 0 ? String(data.pmid) : str(data.pmid);
	const pmid = (pmidValue ?? (/^(?:pubmed|pmid):/i.test(uid) ? uid : '')).replace(/^(?:https?:\/\/pubmed\.ncbi\.nlm\.nih\.gov\/|(?:pubmed|pmid):)/i, '').replace(/\/$/, '');
	const pmcid = (str(data.pmcid) ?? (/^pmc:/i.test(uid) ? uid : '')).replace(/^(?:https?:\/\/(?:www\.)?(?:ncbi\.nlm\.nih\.gov\/pmc|pmc\.ncbi\.nlm\.nih\.gov)\/articles\/|pmc:)/i, '').replace(/\/$/, '').toUpperCase();
	const openalex = (str(data.openalex) ?? '').replace(/^https?:\/\/openalex\.org\/(?:works\/)?/i, '').replace(/\/$/, '').toUpperCase();
	return {
		doi: normalizeDoi(data.doi ?? (/^doi:/i.test(uid) ? uid : undefined)),
		pmid: /^\d+$/.test(pmid) ? pmid : undefined,
		pmcid: /^PMC\d+$/.test(pmcid) ? pmcid : undefined,
		openalex: /^W\d+$/.test(openalex) ? openalex : undefined,
	};
}

/** Never infer identifiers from an arbitrary title or prose. */
export function identifierKeys(ids: PublicationIds): string[] {
	return Object.entries(ids).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1])
		.map(([kind, value]) => `${kind}:${value}`);
}

export function safeArticleUrl(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length > 2081 || /[\u0000-\u0020]/.test(value)) return undefined;
	try {
		const url = new URL(value);
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname ||
			/^(?:localhost|127\.|0\.|\[::1\])/.test(url.hostname) || url.hostname.endsWith('.local')) return undefined;
		return url.href;
	} catch { return undefined; }
}

export function recordLinks(ids: PublicationIds): AccessLink[] {
	const links: AccessLink[] = [];
	if (ids.pmcid) links.push({ kind: 'open-access', url: `https://pmc.ncbi.nlm.nih.gov/articles/${ids.pmcid}/`, label: 'PMC article' });
	if (ids.doi) links.push({ kind: 'publisher', url: `https://doi.org/${ids.doi.split('/').map(encodeURIComponent).join('/')}`, label: 'DOI / publisher' });
	if (ids.pmid) links.push({ kind: 'record', url: `https://pubmed.ncbi.nlm.nih.gov/${ids.pmid}/`, label: 'PubMed record' });
	if (ids.openalex) links.push({ kind: 'record', url: `https://openalex.org/works/${ids.openalex}`, label: 'OpenAlex record' });
	return links.filter(link => safeArticleUrl(link.url));
}

export function preferredLink(records: PublicationRecord[]): AccessLink | undefined {
	const links = records.flatMap(r => r.accessLinks).filter(link => safeArticleUrl(link.url));
	return links.find(l => l.kind === 'open-access') ?? links.find(l => l.kind === 'publisher') ?? links[0];
}

export interface PublicationHit {
	key: string;
	/** Preferred citation; alternate values stay in records, including abstracts. */
	citation: PublicationRecord;
	records: PublicationRecord[];
	conflicts: string[];
}

function contradict(a: PublicationRecord, b: PublicationRecord): boolean {
	return (['doi', 'pmid', 'pmcid'] as const).some(k => a.identifiers[k] && b.identifiers[k] && a.identifiers[k] !== b.identifiers[k]);
}

function same(a: PublicationRecord, b: PublicationRecord): boolean {
	if (a.source === b.source && a.sourceRecordId === b.sourceRecordId) return true;
	return (['doi', 'pmid', 'pmcid'] as const).some(k => a.identifiers[k] && a.identifiers[k] === b.identifiers[k]);
}

/** No title matching, score blending, version conflation or contradictory transitive joins. */
export function aggregatePublications(records: PublicationRecord[]): PublicationHit[] {
	const hits: PublicationHit[] = [];
	for (const record of records) {
		const hit = hits.find(h => h.records.some(r => same(r, record)) && h.records.every(r => !contradict(r, record)));
		if (hit) {
			if (hit.records.some(r => r.source === record.source && r.sourceRecordId === record.sourceRecordId)) continue;
			hit.records.push(record);
			if (record.source === 'pubmed') hit.citation = record;
		} else {
			const key = `${record.source}:${record.sourceRecordId}`;
			hits.push({ key: hits.some(h => h.key === key) ? `${key}:conflict:${hits.length}` : key, citation: record, records: [record], conflicts: [] });
		}
	}
	for (const hit of hits) {
		const preferred = hit.citation;
		const nonempty = (value: unknown) => value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
		const field = <K extends keyof PublicationRecord>(key: K): PublicationRecord[K] =>
			nonempty(preferred[key]) ? preferred[key] : hit.records.find(record => nonempty(record[key]))?.[key] ?? preferred[key];
		hit.citation = { ...preferred, title: field('title'), authors: field('authors'), year: field('year'), venue: field('venue'), publicationTypes: field('publicationTypes') };
		for (const field of ['title', 'year', 'venue', 'authors', 'publicationTypes'] as const) {
			const values = new Set(hit.records.map(r => JSON.stringify(r[field])).filter(v => v !== undefined && v !== '""' && v !== '[]'));
			if (values.size > 1) hit.conflicts.push(field);
		}
		if (hits.some(other => other !== hit && other.records.some(a => hit.records.some(b => same(a, b))))) {
			hit.conflicts.push('identifiers (kept separate)');
		}
	}
	return hits;
}
