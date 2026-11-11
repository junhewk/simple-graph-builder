import assert from 'node:assert/strict';
import { aggregatePublications, identifiers, normalizeDoi, preferredLink, recordLinks, safeArticleUrl } from '../src/literature/results';
import { VaultReferenceIndex } from '../src/literature/vault-index';
import { openArticleExternally } from '../src/literature/external-links';
import { LiteratureCredentialStore } from '../src/literature/credentials';
import type { PublicationRecord } from '../src/literature/types';

const record = (source: PublicationRecord['source'], id: string, ids = {}): PublicationRecord => ({
	source, sourceRecordId: id, identifiers: identifiers(ids), sourceRank: 1, retrievedAt: '2026-11-11T00:00:00Z',
	title: 'Same title', authors: ['A Author'], year: 2025, venue: 'Journal A', publicationTypes: ['article'],
	abstract: { state: 'missing' }, accessLinks: recordLinks(identifiers(ids)),
});

async function main() {
	assert.equal(normalizeDoi(' DOI:10.1234/Example(1) '), '10.1234/example(1)', 'valid punctuation is not stripped');
	assert.equal(normalizeDoi('https://doi.org/10.1234/a%23b?tracking=1'), '10.1234/a#b');
	assert.equal(normalizeDoi('not a DOI'), undefined);
	assert.equal(identifiers({ pmid: 12345 }).pmid, '12345');
	assert.equal(identifiers({ pmid: 'https://pubmed.ncbi.nlm.nih.gov/12345/' }).pmid, '12345');
	assert.equal(identifiers({ uid: 'pubmed:12345' }).pmid, '12345');
	assert.equal(identifiers({ uid: 'pmc:PMC123' }).pmcid, 'PMC123');
	assert.equal(identifiers({ openalex: 'https://openalex.org/works/W123/' }).openalex, 'W123');
	const pubmed = record('pubmed', '1', { pmid: '1', doi: '10.1234/one' });
	const oa = { ...record('openalex', 'W1', { doi: 'https://doi.org/10.1234/ONE', pmid: '1' }), title: 'Different title', year: 2024 };
	oa.abstract = { state: 'available', sections: [{ text: 'An available abstract.' }] };
	let hits = aggregatePublications([oa, pubmed, pubmed]);
	assert.equal(hits.length, 1);
	assert.equal(hits[0].records.length, 2);
	assert.equal(hits[0].citation.title, pubmed.title);
	assert.equal(hits[0].records.find(r => r.source === 'openalex')?.abstract.state, 'available');
	assert.ok(hits[0].conflicts.includes('year'));
	hits = aggregatePublications([{ ...pubmed, title: undefined }, oa]);
	assert.equal(hits[0].citation.title, oa.title, 'missing preferred metadata can fall back to another source without losing originals');
	assert.equal(hits[0].records[0].title, undefined);
	const contradictory = record('openalex', 'W2', { doi: '10.1234/one', pmid: '2' });
	hits = aggregatePublications([pubmed, contradictory]);
	assert.equal(hits.length, 2, 'contradictory PMID records do not merge through a DOI');
	assert.ok(hits.every(hit => hit.conflicts.some(c => c.includes('identifiers'))));
	const bridge = record('openalex', 'W3', { doi: '10.1234/one' });
	assert.equal(aggregatePublications([pubmed, bridge, contradictory]).length, 2, 'an incomplete record does not bridge conflicting identities');
	assert.equal(aggregatePublications([record('openalex', 'W4'), record('openalex', 'W5')]).length, 2, 'equal titles without reliable IDs are not merged');
	const index = new VaultReferenceIndex([
		{ path: 'A.md', identifiers: identifiers({ doi: '10.1234/one', pmid: '1' }) },
		{ path: 'B.md', identifiers: identifiers({ doi: '10.1234/one', pmid: '2' }) },
		{ path: 'C.md', identifiers: identifiers({ pmcid: 'PMC123' }) },
	]);
	assert.deepEqual(index.find(pubmed.identifiers), ['A.md']);
	assert.deepEqual(index.find({ pmcid: 'PMC123' }), ['C.md']);
	assert.deepEqual(index.find({}), []);
	for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'obsidian://new', 'https://user:pass@example.org', 'https://localhost/a', 'not a URL']) {
		assert.equal(safeArticleUrl(url), undefined, url);
	}
	for (let code = 0; code <= 32; code++) {
		assert.equal(safeArticleUrl(`https://example.org/a${String.fromCharCode(code)}b`), undefined, `reject raw ASCII control/space ${code}`);
	}
	assert.equal(safeArticleUrl('https://example.org/a%20b'), 'https://example.org/a%20b', 'encoded spaces remain valid');
	const oaLink = { kind: 'open-access' as const, label: 'OA landing page', url: 'https://example.org/article' };
	assert.deepEqual(preferredLink([pubmed, { ...oa, accessLinks: [oaLink] }]), oaLink);
	const opened: string[] = [];
	let loads = 0;
	await openArticleExternally('https://example.org/article', { desktop: true, loadShell: () => { loads++; return { openExternal: async url => { opened.push(url); } }; }, open: () => { throw new Error('desktop must bypass a web viewer'); } });
	assert.deepEqual(opened, ['https://example.org/article']);
	await assert.rejects(() => openArticleExternally('javascript:alert(1)', { desktop: true, loadShell: () => { loads++; return undefined; }, open: () => {} }), /valid HTTP/);
	assert.equal(loads, 1, 'invalid URLs cannot reach an opener');
	await openArticleExternally('https://example.org/mobile', { desktop: false, loadShell: () => { throw new Error('no Electron on mobile'); }, open: url => { opened.push(url); } });
	assert.equal(opened[1], 'https://example.org/mobile');

	const saved = new Map<string, string>();
	const persistent = new LiteratureCredentialStore({ secretStorage: { getSecret: (id: string) => saved.get(id) ?? null, setSecret: (id: string, value: string) => saved.set(id, value) } });
	persistent.set('pubmed', ' ncbi-test ');
	assert.equal(persistent.get('pubmed'), 'ncbi-test');
	assert.equal(persistent.get('openalex'), '', 'keys are source-specific');
	assert.equal(persistent.persistent, true);
	const session = new LiteratureCredentialStore({});
	session.set('openalex', 'oa-session');
	assert.equal(session.read('').pubmed, '');
	assert.equal(session.read('').openalex, 'oa-session');
	session.clearSession();
	assert.equal(session.get('openalex'), '');
	assert.equal(session.persistent, false);
	console.log('ok   literature normalization, conservative identity, provenance, credentials and external links');
}
main().catch(error => { console.error('FAIL', error); process.exit(1); });
