import { LiteratureHttp, LiteratureHttpError, parseJson } from '../http';
import { identifiers, object, recordLinks, str } from '../results';
import type { CompiledSearch, LiteratureAdapter, LiteratureCredentials, LiteraturePage, PageToken, PublicationRecord } from '../types';

const BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';

function requestUrlFor(utility: string, params: Record<string, string>, credentials: LiteratureCredentials): string {
	const query = new URLSearchParams({ db: 'pubmed', tool: 'simple-graph-builder', ...params });
	if (credentials.contactEmail) query.set('email', credentials.contactEmail);
	if (credentials.pubmed) query.set('api_key', credentials.pubmed);
	return BASE + utility + '.fcgi?' + query.toString();
}

export class PubMedAdapter implements LiteratureAdapter {
	constructor(private readonly http: LiteratureHttp) {}

	async search(spec: CompiledSearch, credentials: LiteratureCredentials, active: () => boolean, next?: PageToken): Promise<LiteraturePage> {
		let ids: string[];
		let offset = 0;
		let total = 0;
		let translation: string | undefined;
		const warnings: string[] = [];
		if (next?.kind === 'pubmed') {
			ids = next.ids.slice(0, spec.limit);
			offset = next.offset;
		} else {
			const params: Record<string, string> = { term: spec.query, retmode: 'json', retmax: String(spec.limit), sort: 'relevance' };
			if (spec.from) Object.assign(params, { datetype: 'pdat', mindate: spec.from.replace(/-/g, '/'), maxdate: spec.to.replace(/-/g, '/') });
			const response = await this.http.get('pubmed', { url: requestUrlFor('esearch', params, credentials) }, active);
			const data = parseJson(response.text);
			const result = object(data.esearchresult);
			if (data.error || result.error || !Array.isArray(result.idlist) || !/^\d+$/.test(String(result.count))) {
				throw new LiteratureHttpError('PubMed could not interpret this search. Check the query and fields.');
			}
			ids = [...new Set(result.idlist.filter((id): id is string => typeof id === 'string' && /^\d+$/.test(id)))].slice(0, spec.limit);
			total = Number(result.count);
			translation = str(result.querytranslation);
			for (const list of [object(result.warninglist), object(result.errorlist)]) {
				for (const [key, value] of Object.entries(list)) {
					const values = Array.isArray(value) ? value : [value];
					for (const warning of values) if (typeof warning === 'string') warnings.push(`${key}: ${warning.slice(0, 500)}`);
				}
			}
		}
		const batch = ids.slice(offset, offset + spec.pageSize);
		if (!batch.length) return { records: [], total, warnings, translation };
		const response = await this.http.get('pubmed', {
			url: requestUrlFor('efetch', { id: batch.join(','), retmode: 'xml' }, credentials),
		}, active);
		const records = parsePubMedXml(response.text, batch, offset);
		if (!records.length) throw new LiteratureHttpError('PubMed found identifiers but returned no citation records. Retry this source.');
		if (records.length < batch.length) warnings.push('PubMed did not return every requested citation. Missing records were not treated as empty abstracts.');
		return {
			records, total: next ? ids.length : total, translation, warnings,
			next: offset + batch.length < ids.length ? { kind: 'pubmed', ids, offset: offset + batch.length } : undefined,
		};
	}
}

function elements(parent: Document | Element, tag: string): Element[] {
	return Array.from(parent.getElementsByTagName(tag));
}

function text(parent: Document | Element | undefined, tag: string): string | undefined {
	return parent ? elements(parent, tag)[0]?.textContent?.trim() : undefined;
}

/** Parse inert XML and read textContent only; returned elements never enter Obsidian's DOM. */
export function parsePubMedXml(xml: string, orderedIds: string[], offset = 0): PublicationRecord[] {
	if (/<!ENTITY/i.test(xml) || xml.length > 10_000_000) throw new LiteratureHttpError('PubMed returned unsupported XML.');
	const doc = new DOMParser().parseFromString(xml, 'application/xml');
	if (elements(doc, 'parsererror').length || !elements(doc, 'PubmedArticleSet').length || elements(doc, 'ERROR').length) {
		throw new LiteratureHttpError('PubMed returned an invalid citation response. Retry the search.');
	}
	const byId = new Map<string, PublicationRecord>();
	for (const citation of [...elements(doc, 'PubmedArticle'), ...elements(doc, 'PubmedBookArticle')]) {
		const pmid = text(citation, 'PMID');
		if (!pmid || !orderedIds.includes(pmid)) continue;
		const article = elements(citation, 'Article')[0] ?? elements(citation, 'BookDocument')[0];
		if (!article) continue;
		const rawIds: Record<string, string> = { pmid };
		const idList = elements(citation, 'ArticleIdList')[0];
		for (const id of idList ? elements(idList, 'ArticleId') : []) {
			const kind = id.getAttribute('IdType');
			if (kind === 'doi') rawIds.doi = id.textContent?.trim() ?? '';
			if (kind === 'pmc') rawIds.pmcid = id.textContent?.trim() ?? '';
		}
		const ids = identifiers(rawIds);
		const abstract = elements(article, 'Abstract')[0];
		const sections = abstract ? elements(abstract, 'AbstractText').map(part => ({ label: part.getAttribute('Label') || undefined, text: part.textContent?.trim() ?? '' })) : [];
		const authors = elements(article, 'AuthorList')[0];
		const pubDate = elements(article, 'PubDate')[0] ?? elements(article, 'ArticleDate')[0];
		const rawYear = text(pubDate, 'Year') || text(pubDate, 'MedlineDate')?.match(/\b\d{4}\b/)?.[0];
		const types = elements(article, 'PublicationTypeList')[0];
		byId.set(pmid, {
			source: 'pubmed', sourceRecordId: pmid, retrievedAt: new Date().toISOString(), sourceRank: offset + orderedIds.indexOf(pmid) + 1,
			title: text(article, 'ArticleTitle') ?? text(article, 'BookTitle'),
			authors: authors ? elements(authors, 'Author').map(author => text(author, 'CollectiveName') ||
				[text(author, 'ForeName') || text(author, 'Initials'), text(author, 'LastName')].filter(Boolean).join(' ')).filter(Boolean) : undefined,
			year: rawYear && /^\d{4}$/.test(rawYear) ? Number(rawYear) : undefined,
			venue: text(elements(article, 'Journal')[0], 'Title') ?? text(article, 'BookTitle'),
			publicationTypes: types ? elements(types, 'PublicationType').map(type => type.textContent?.trim() ?? '').filter(Boolean) : undefined,
			abstract: !abstract ? { state: 'missing' } : sections.some(section => section.text) ? { state: 'available', sections } : { state: 'empty' },
			identifiers: ids, accessLinks: recordLinks(ids),
		});
	}
	return orderedIds.flatMap(id => byId.has(id) ? [byId.get(id)!] : []);
}
