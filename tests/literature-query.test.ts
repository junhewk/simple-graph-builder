import assert from 'node:assert/strict';
import { compileQuery, draftFromContext } from '../src/literature/query';
import type { LiteratureGraphContext } from '../src/literature/types';

const context: LiteratureGraphContext = {
	version: 1, capturedAt: '2026-11-11T00:00:00Z', graphRevision: 1,
	startingNodeId: 'a', selectedNodeId: 'c', discovery: 'propagation', historyTruncated: false,
	scope: { includesNoteNodes: false, filtered: false, truncated: false },
	nodes: [
		{ id: 'a', name: 'Education', aliases: [], type: 'CONCEPT', identifiers: {}, sourceNotes: [] },
		{ id: 'b', name: 'Feedback', aliases: [], type: 'CONCEPT', identifiers: {}, sourceNotes: [] },
		{ id: 'c', name: '의도적 연습', aliases: ['deliberate practice', 'DP'], type: 'METHOD', identifiers: {}, sourceNotes: [] },
	], route: [{ nodeId: 'a' }, { nodeId: 'b' }, { nodeId: 'c' }],
};
const draft = draftFromContext(context);
assert.deepEqual(draft.groups, [{ conceptId: 'c', expressions: ['의도적 연습'] }], 'a route does not make every concept required or every alias selected');
assert.equal(compileQuery(draft, 'pubmed').query, '("의도적 연습"[tiab])');
draft.groups = [{ expressions: ['simulation', 'SBME', ' SIMULATION '] }, { expressions: ['deliberate practice'] }];
assert.equal(compileQuery(draft, 'pubmed').query, '("simulation"[tiab] OR "SBME"[tiab]) AND ("deliberate practice"[tiab])');
assert.equal(compileQuery(draft, 'openalex').query, '("simulation" OR "SBME") AND ("deliberate practice")');
draft.groups = [{ expressions: ['의학교육'.normalize('NFD'), '의학교육'] }];
assert.equal(compileQuery(draft, 'openalex').query, '("의학교육")', 'NFC is used without translation or bigram expansion');
for (const expression of ['x" OR "y', 'practice[tiab]', 'practice]', 'practice\\feedback', 'practice\nfeedback', 'practice\rfeedback']) {
	draft.groups[0].expressions = [expression];
	assert.throws(() => compileQuery(draft, 'pubmed'), /plain expressions/);
	assert.throws(() => compileQuery(draft, 'openalex'), /plain expressions/);
}
draft.nativeOverrides.pubmed = '(asthma[MeSH Terms]) AND education[tiab]';
assert.equal(compileQuery(draft, 'pubmed').scope, 'provider-native query');
draft.groups = [];
assert.match(compileQuery(draft, 'pubmed').query, /MeSH/, 'manual source edits are not overwritten by concept edits');
draft.nativeOverrides.openalex = 'asthma[tiab]';
assert.throws(() => compileQuery(draft, 'openalex'), /PubMed field tags/);
draft.nativeOverrides.openalex = '(asthma AND education';
assert.throws(() => compileQuery(draft, 'openalex'), /unbalanced/);
draft.nativeOverrides.openalex = '"asthma';
assert.throws(() => compileQuery(draft, 'openalex'), /unbalanced/);
draft.nativeOverrides.openalex = '';
assert.throws(() => compileQuery(draft, 'openalex'), /empty/);
draft.nativeOverrides.openalex = 'asthma AND education';
draft.from = '2024-02-30'; draft.to = '2026-11-11';
assert.throws(() => compileQuery(draft, 'openalex'), /dates/);
draft.from = '2024-02-29';
assert.equal(compileQuery(draft, 'openalex').from, '2024-02-29');
draft.to = '';
assert.throws(() => compileQuery(draft, 'pubmed'), /both publication dates/);
draft.to = '2023-01-01';
assert.throws(() => compileQuery(draft, 'pubmed'), /start before/);
draft.from = ''; draft.to = ''; draft.limit = 101;
assert.throws(() => compileQuery(draft, 'pubmed'), /100/);
draft.limit = 100; draft.nativeOverrides.openalex = '가'.repeat(1000);
assert.throws(() => compileQuery(draft, 'openalex'), /too long/);
console.log('ok   literature query grouping, overrides, Unicode and bounds');
