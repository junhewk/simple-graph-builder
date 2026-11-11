import assert from 'node:assert/strict';
import { LiteratureHttp, LiteratureHttpError, LiteratureResponse } from '../src/literature/http';
import { LiteratureService } from '../src/literature/service';
import type { CompiledSearch, LiteratureAdapter, LiteraturePage, PublicationRecord } from '../src/literature/types';

(globalThis as any).window = { setTimeout, clearTimeout };
const spec: CompiledSearch = { source: 'pubmed', query: 'old', from: '', to: '', pageSize: 20, limit: 100, sort: 'relevance', scope: 'title/abstract' };
const record = (id: string): PublicationRecord => ({ source: 'pubmed', sourceRecordId: id, retrievedAt: '2026-11-11T00:00:00Z', sourceRank: 1, identifiers: { pmid: id }, abstract: { state: 'missing' }, accessLinks: [] });
const page = (id: string): LiteraturePage => ({ records: [record(id)], total: 40, warnings: [], next: { kind: 'pubmed', ids: [id, 'next'], offset: 1 } });
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function main() {
	let calls = 0;
	let oaFails = true;
	let retryKey = '';
	const old = deferred<LiteraturePage>();
	const stopped = deferred<LiteraturePage>();
	let failMore = true;
	const pubmed: LiteratureAdapter = { search: async (search, _creds, _active, token) => {
		calls++;
		if (search.query === 'old') return old.promise;
		if (search.query === 'stopped') return stopped.promise;
		if (token) { if (failMore) throw new Error('fetch failed'); return { ...page('next'), next: undefined }; }
		return page('new');
	} };
	const openalex: LiteratureAdapter = { search: async (_search, creds) => {
		retryKey = creds.openalex ?? '';
		if (oaFails) throw new Error('OpenAlex failed');
		return { records: [], total: 0, warnings: [] };
	} };
	let clock = 0;
	const service = new LiteratureService({ pubmed, openalex }, () => clock);
	let updates = 0;
	const session = service.createSession(() => { updates++; });
	assert.equal(calls, 0, 'constructing a session sends no request');
	const first = session.start([spec], { contactEmail: '' });
	await tick();
	await session.start([{ ...spec, query: 'new' }, { ...spec, source: 'openalex', query: 'new' }], { contactEmail: '' });
	assert.equal(session.state.sources.pubmed?.records[0].sourceRecordId, 'new');
	assert.equal(session.state.sources.openalex?.status, 'error', 'one failing source leaves the other source usable');
	old.resolve(page('old'));
	await first;
	assert.equal(session.state.sources.pubmed?.records[0].sourceRecordId, 'new', 'late old search cannot replace new results');
	oaFails = false;
	await session.retry('openalex', { contactEmail: '', openalex: 'updated-key' });
	assert.equal(session.state.sources.openalex?.status, 'empty');
	assert.equal(retryKey, 'updated-key', 'retry can use a corrected API key');
	await session.loadMore('pubmed');
	assert.equal(session.state.sources.pubmed?.status, 'error');
	assert.equal(session.state.sources.pubmed?.records.length, 1, 'a failed additional page does not erase earlier results');
	failMore = false;
	await session.retry('pubmed');
	assert.deepEqual(session.state.sources.pubmed?.records.map(r => r.sourceRecordId), ['new', 'next']);
	assert.equal(session.state.sources.pubmed?.total, 40, 'captured total remains stable across PMID batches');
	assert.equal(session.state.sources.pubmed?.next, undefined);
	const beforeCache = calls;
	const second = service.createSession(() => {});
	await second.start([{ ...spec, query: 'new' }], { contactEmail: '' });
	assert.equal(calls, beforeCache);
	assert.equal(second.state.sources.pubmed?.cached, true);
	clock = 600001;
	await second.start([{ ...spec, query: 'new' }], { contactEmail: '' });
	assert.equal(calls, beforeCache + 1, 'expired cache triggers a new retrieval');
	const pending = second.start([{ ...spec, query: 'stopped' }], { contactEmail: '' });
	await tick(); second.stop(); stopped.resolve(page('late')); await pending;
	assert.equal(second.state.sources.pubmed?.status, 'stopped');
	assert.equal(second.state.sources.pubmed?.records.length, 0);
	const beforeDispose = updates;
	session.dispose();
	await session.start([spec], { contactEmail: '' });
	assert.equal(updates, beforeDispose);
	service.dispose();

	let boundedCacheCalls = 0;
	const cacheAdapter: LiteratureAdapter = { search: async search => {
		boundedCacheCalls++;
		const count = search.query.startsWith('large') ? 50 : 1;
		return { records: Array.from({ length: count }, (_, index) => record(`${search.query}-${index}`)), total: count, warnings: [] };
	} };
	for (const [prefix, count] of [['small', 26], ['large', 11]] as const) {
		const boundedCache = new LiteratureService({ pubmed: cacheAdapter, openalex: cacheAdapter });
		const cacheSession = boundedCache.createSession(() => {});
		const run = (index: number) => cacheSession.start([{ ...spec, query: `${prefix}-${index}` }], { contactEmail: '' });
		for (let index = 0; index < count; index++) await run(index);
		const callsBefore = boundedCacheCalls;
		await run(count - 1);
		assert.equal(boundedCacheCalls, callsBefore, 'the most recent page remains cached');
		await run(0);
		assert.equal(boundedCacheCalls, callsBefore + 1, `${prefix === 'small' ? 'page-count' : 'record-count'} limits evict older pages`);
		boundedCache.dispose();
	}

	let requests = 0;
	let now = 0;
	const starts: number[] = [];
	const waits: number[] = [];
	const http = new LiteratureHttp(async (): Promise<LiteratureResponse> => {
		requests++; starts.push(now);
		return requests === 1 ? { status: 429, headers: { 'Retry-After': '2' }, text: '{}' } : { status: 200, headers: {}, text: '{}' };
	}, async ms => { waits.push(ms); now += ms; }, () => now);
	await http.get('pubmed', { url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi' }, () => true);
	assert.equal(requests, 2);
	assert.ok(waits.includes(2000));
	assert.ok(starts[1] - starts[0] >= 1000, 'retries honor source pacing');
	let quotaRequests = 0;
	const quota = new LiteratureHttp(async () => { quotaRequests++; return { status: 429, headers: { 'X-RateLimit-Remaining': '0' }, text: '{"message":"daily budget exhausted"}' }; }, async () => {}, Date.now, 0);
	await assert.rejects(() => quota.get('openalex', { url: 'https://api.openalex.org/works' }, () => true), /allowance is exhausted/);
	assert.equal(quotaRequests, 1, 'daily allowance errors are not retried');
	const invalidKey = new LiteratureHttp(async () => ({ status: 403, headers: {}, text: '<html>not JSON</html>' }), async () => {}, Date.now, 0);
	await assert.rejects(() => invalidKey.get('openalex', { url: 'https://api.openalex.org/works' }, () => true), /rejected the API key/);
	await assert.rejects(() => invalidKey.get('openalex', { url: 'https://example.org/article' }, () => true), /Invalid literature API destination/);

	const physical = deferred<{ status: number; text: string; headers: Record<string, string> }>();
	let physicalCalls = 0;
	const bounded = new LiteratureHttp(() => { physicalCalls++; return physical.promise; }, async () => {}, Date.now, 0, 10);
	const timeout = bounded.get('pubmed', { url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi' }, () => true);
	await assert.rejects(() => timeout, (error: unknown) => error instanceof LiteratureHttpError && /timed out/.test(error.message));
	let active = true;
	const queued = bounded.get('pubmed', { url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi' }, () => active);
	active = false;
	assert.equal(physicalCalls, 1, 'a UI timeout does not release an outstanding physical request slot');
	physical.resolve({ status: 200, headers: {}, text: '{}' });
	await assert.rejects(() => queued, /stopped/);
	assert.equal(physicalCalls, 1, 'stopped queued requests never reach the network');
	console.log('ok   literature partial failure, stale responses, retry, pagination, cache and bounded transport');
}
main().catch(error => { console.error('FAIL', error); process.exit(1); });
