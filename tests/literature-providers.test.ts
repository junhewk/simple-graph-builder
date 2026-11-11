import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOMParser as NodeDOMParser } from '@xmldom/xmldom';
import { allRequests, setQueue } from './obsidian-stub';
import { LiteratureHttp } from '../src/literature/http';
import { PubMedAdapter, parsePubMedXml } from '../src/literature/providers/pubmed';
import { normalizeOpenAlex, OpenAlexAdapter, reconstructAbstract } from '../src/literature/providers/openalex';
import type { CompiledSearch } from '../src/literature/types';

(globalThis as any).DOMParser = NodeDOMParser;
(globalThis as any).window = { setTimeout, clearTimeout };
const fixture = (name: string) => readFileSync(join(process.cwd(), 'tests/fixtures/literature', name), 'utf8');
const xml = fixture('pubmed.xml');
const oa = fixture('openalex.json');
const spec: CompiledSearch = { source: 'pubmed', query: '("practice"[tiab])', from: '2020-01-01', to: '2026-11-11', pageSize: 2, limit: 3, scope: 'title/abstract', sort: 'relevance' };
const credentials = { contactEmail: 'maintainer@example.org', pubmed: 'test-ncbi', openalex: 'test-openalex' };

async function main() {
	const http = new LiteratureHttp(undefined, async () => undefined, Date.now, 0);
	const pubmed = new PubMedAdapter(http);
	setQueue([
		{ status: 200, body: { esearchresult: { count: '50', idlist: ['10001', '10002', '10003'], querytranslation: 'translated query', warninglist: { phrasesignored: ['example warning'] } } } },
		{ status: 200, text: xml }, { status: 200, text: xml },
	]);
	const page = await pubmed.search(spec, credentials, () => true);
	const search = new URL(allRequests[0].url);
	assert.equal(search.hostname, 'eutils.ncbi.nlm.nih.gov');
	assert.equal(search.searchParams.get('retmode'), 'json');
	assert.equal(search.searchParams.get('term'), spec.query);
	assert.equal(search.searchParams.get('retmax'), '3');
	assert.equal(search.searchParams.get('sort'), 'relevance');
	assert.equal(search.searchParams.get('datetype'), 'pdat');
	assert.equal(search.searchParams.get('mindate'), '2020/01/01');
	assert.equal(search.searchParams.get('email'), credentials.contactEmail);
	assert.equal(search.searchParams.get('tool'), 'simple-graph-builder');
	assert.equal(search.searchParams.get('api_key'), 'test-ncbi');
	assert.equal(new URL(allRequests[1].url).searchParams.get('id'), '10001,10002');
	assert.equal(new URL(allRequests[1].url).searchParams.get('retmode'), 'xml');
	assert.deepEqual(page.records.map(r => r.sourceRecordId), ['10001', '10002'], 'EFetch records are reordered to ESearch rank');
	assert.equal(page.records[0].title, 'Practice & feedback: 의학교육');
	assert.deepEqual(page.records[0].authors, ['Jun Kim', 'JH Lee']);
	assert.equal(page.records[0].identifiers.doi, '10.1234/example.1');
	assert.equal(page.records[0].abstract.state, 'available');
	if (page.records[0].abstract.state === 'available') assert.equal(page.records[0].abstract.sections[0].text, 'A <script>literal</script> string.');
	assert.equal(page.records[1].abstract.state, 'missing');
	assert.equal(page.records[1].year, 2024);
	assert.equal(page.translation, 'translated query');
	assert.match(page.warnings[0], /example warning/);
	const more = await pubmed.search(spec, credentials, () => true, page.next);
	assert.equal(allRequests.length, 3, 'paging does not repeat ESearch or fetch every record separately');
	assert.equal(new URL(allRequests[2].url).searchParams.get('id'), '10003');
	assert.equal(more.records[0].sourceRank, 3);
	assert.equal(more.records[0].abstract.state, 'empty');
	assert.equal(more.records[0].title, '');
	assert.deepEqual(more.records[0].authors, []);
	assert.equal(more.next, undefined);
	assert.throws(() => parsePubMedXml('<html>gateway</html>', ['10001']), /invalid citation/);
	assert.throws(() => parsePubMedXml('<!DOCTYPE x [<!ENTITY x "test">]><PubmedArticleSet/>', []), /unsupported XML/);

	const openalex = new OpenAlexAdapter(http);
	setQueue([{ status: 200, text: oa }]);
	const oaPage = await openalex.search({ ...spec, source: 'openalex', query: '("practice" OR "DP") AND "feedback"' }, credentials, () => true);
	const request = allRequests[3];
	const url = new URL(request.url);
	assert.equal(url.searchParams.get('search.title_and_abstract'), '("practice" OR "DP") AND "feedback"');
	assert.equal(url.searchParams.get('search'), null);
	assert.equal(url.searchParams.get('rerank'), 'false');
	assert.equal(url.searchParams.get('filter'), 'from_publication_date:2020-01-01,to_publication_date:2026-11-11');
	assert.equal(url.searchParams.get('page'), '1');
	assert.equal(url.searchParams.get('per_page'), '2');
	assert.equal(request.headers.Authorization, 'Bearer test-openalex');
	assert.equal(url.searchParams.get('api_key'), null, 'the key is not in the URL');
	assert.deepEqual(oaPage.next, { kind: 'openalex', page: 2 });
	assert.equal(oaPage.records[0].identifiers.pmid, '10001');
	assert.deepEqual(oaPage.records[0].abstract, { state: 'available', sections: [{ text: 'Practice needs feedback. Practice continues.' }] });
	assert.equal(oaPage.records[1].abstract.state, 'missing');
	assert.ok(oaPage.records[1].accessLinks.every(link => link.url.startsWith('https:')));
	const repeatedLink = normalizeOpenAlex({ id: 'https://openalex.org/W1', doi: '10.1234/example',
		best_oa_location: { is_oa: true, landing_page_url: 'https://doi.org/10.1234/example' } }, 1)!;
	assert.equal(repeatedLink.accessLinks.filter(link => link.url === 'https://doi.org/10.1234/example').length, 1);
	assert.equal(repeatedLink.accessLinks[0].kind, 'open-access', 'a repeated destination keeps the preferred access label');
	assert.equal(reconstructAbstract({}).state, 'empty');
	assert.equal(reconstructAbstract({ x: [1000000000] }).state, 'error', 'sparse indexes cannot allocate huge arrays');
	assert.equal(reconstructAbstract({ x: [0], y: [0] }).state, 'error');
	assert.equal(reconstructAbstract({ x: [1] }).state, 'error');
	setQueue([{ status: 200, body: { error: 'API rate limit exceeded' } }]);
	await assert.rejects(() => pubmed.search(spec, credentials, () => true), /could not interpret/);
	setQueue([{ status: 200, text: '<html>gateway</html>' }]);
	await assert.rejects(() => openalex.search(spec, credentials, () => true), /invalid JSON/);
	setQueue([{ status: 200, body: { meta: { count: 0 }, results: [] } }]);
	assert.equal((await openalex.search(spec, { contactEmail: '' }, () => true)).records.length, 0);
	assert.equal(allRequests[allRequests.length - 1].headers, undefined, 'anonymous search sends no extraction credentials');
	console.log('ok   literature API requests, XML, abstracts, metadata and pagination');
}

main().catch(error => { console.error('FAIL', error); process.exit(1); });
