/** Explicit live smoke test. Never run by npm test; no model calls or vault writes. */
import assert from 'node:assert/strict';
import { DOMParser as NodeDOMParser } from '@xmldom/xmldom';
import { LiteratureHttp } from '../src/literature/http';
import { PubMedAdapter } from '../src/literature/providers/pubmed';
import { OpenAlexAdapter } from '../src/literature/providers/openalex';
import type { CompiledSearch } from '../src/literature/types';

(globalThis as any).DOMParser = NodeDOMParser;
(globalThis as any).window = { setTimeout, clearTimeout };

async function main() {
	const http = new LiteratureHttp();
	const credentials = { contactEmail: process.env.SGB_LITERATURE_EMAIL ?? '', pubmed: process.env.SGB_PUBMED_API_KEY, openalex: process.env.SGB_OPENALEX_API_KEY };
	const spec: CompiledSearch = { source: 'pubmed', query: '("deliberate practice"[tiab]) AND ("medical education"[tiab])', from: '', to: '', pageSize: 5, limit: 10, scope: 'title/abstract', sort: 'relevance' };
	const seedPmids = new Set(['21900138', '21512370']);
	const results = await Promise.allSettled([
		new PubMedAdapter(http).search(spec, credentials, () => true),
		new OpenAlexAdapter(http).search({ ...spec, source: 'openalex', query: '("deliberate practice") AND ("medical education")' }, credentials, () => true),
	]);
	let failures = 0;
	for (const [index, result] of results.entries()) {
		const source = index ? 'OpenAlex' : 'PubMed';
		if (result.status === 'rejected') { console.error(`FAIL ${source}: ${result.reason instanceof Error ? result.reason.message : 'request failed'}`); failures++; continue; }
		const page = result.value;
		assert.ok(page.records.length > 0, `${source}: query returns records`);
		assert.ok(page.records.some(record => !record.identifiers.pmid || !seedPmids.has(record.identifiers.pmid)), `${source}: at least one publication is outside the acceptance fixture`);
		console.log(`${source}: ${page.total} reported; ${page.records.length} inspected; IDs: ${page.records.map(record => record.identifiers.pmid ?? record.sourceRecordId).join(', ')}`);
	}
	assert.equal(failures, 0, 'both live sources must pass');
	console.log('ok   live literature searches find publications beyond the fixture, without model calls');
}
main().catch(error => { console.error('FAIL', error); process.exit(1); });
