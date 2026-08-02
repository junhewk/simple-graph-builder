/**
 * Korean text must survive both Unicode normal forms.
 *
 * THE BUG: node ids and every name comparison used `toLowerCase()` alone, which
 * is a no-op on Hangul. Composed (NFC) and decomposed (NFD) spellings of the
 * same word render identically but compare unequal, so:
 *   - one concept became two unconnected nodes
 *   - bigram Jaccard between a word and ITSELF scored exactly 0, silently
 *     defeating the Korean search support the plugin advertises
 * macOS writes NFD in file paths, so any vault mixing typed text with
 * path-derived names accumulated these.
 */
import { fakePlugin } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { generateNodeId, generateEdgeId, normalizeName } from '../src/graph/merge';
import { searchGraphCache } from '../src/graph/search';
import { searchNodes } from '../src/graph/tools';
import { normalizeKey, normalizeUnicode, OntologyEdge, OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const NFC = '머신러닝';
const NFD = NFC.normalize('NFD');

// Sanity: the fixture really does exercise the two encodings
check('fixture uses genuinely different strings', NFC !== NFD, `${NFC.length} vs ${NFD.length} code points`);
check('lowercasing alone does NOT reconcile them', NFC.toLowerCase() !== NFD.toLowerCase());

// --- the primitives ---
check('normalizeKey reconciles NFC and NFD', normalizeKey(NFC) === normalizeKey(NFD));
check('normalizeUnicode composes NFD', normalizeUnicode(NFD) === NFC);
check('normalizeName composes NFD', normalizeName(` ${NFD} `) === NFC);
check('node ids match across forms',
	generateNodeId('CONCEPT', NFC) === generateNodeId('CONCEPT', NFD),
	`${generateNodeId('CONCEPT', NFC)} vs ${generateNodeId('CONCEPT', NFD)}`);
check('edge ids match across forms',
	generateEdgeId(generateNodeId('CONCEPT', NFC), 'concept:x', '사용한다') ===
	generateEdgeId(generateNodeId('CONCEPT', NFD), 'concept:x', '사용한다'.normalize('NFD')));
check('whitespace runs collapse', normalizeKey('기계  학습') === normalizeKey('기계 학습'));
// Conservative on purpose: spacing variants stay distinct at the id level,
// because the same rule would fuse unrelated Latin names.
check('spacing variants remain distinct', normalizeKey('기계 학습') !== normalizeKey('기계학습'));

async function main() {
	// --- migration: an already-damaged graph gets folded back together ---
	const nfcId = `concept:${NFC.toLowerCase()}`;
	const nfdId = `concept:${NFD.toLowerCase()}`;
	check('the damaged fixture really has two ids', nfcId !== nfdId);

	const nodes: OntologyNode[] = [
		{ id: nfcId, entityType: 'CONCEPT', properties: { name: NFC, description: 'short' }, sourceNotes: ['a.md'], createdAt: 200 },
		{ id: nfdId, entityType: 'CONCEPT', properties: { name: NFD, description: 'a longer description' }, sourceNotes: ['b.md'], createdAt: 100 },
		{ id: 'concept:ai', entityType: 'CONCEPT', properties: { name: 'AI' }, sourceNotes: ['a.md'] },
	];
	const edges: OntologyEdge[] = [
		{ id: `${nfcId}->concept:ai:uses`, source: nfcId, target: 'concept:ai', relationship: 'uses', properties: {} },
		// Same relationship from the duplicate: must collapse onto the one above
		{ id: `${nfdId}->concept:ai:uses`, source: nfdId, target: 'concept:ai', relationship: 'uses', properties: {} },
		// An edge BETWEEN the duplicates becomes a self-loop and must be dropped
		{ id: `${nfcId}->${nfdId}:relates to`, source: nfcId, target: nfdId, relationship: 'relates to', properties: {} },
	];

	const cache = new GraphCache(fakePlugin({ nodes, edges, version: 3 }).plugin);
	await cache.ensureLoaded();

	check('the duplicate node is merged away', cache.getAllNodes().length === 2, String(cache.getAllNodes().length));
	check('merge count is reported', cache.getMergedDuplicateCount() === 1, String(cache.getMergedDuplicateCount()));

	const survivor = cache.getNodeById(normalizeKey(nfcId));
	check('survivor is reachable by its canonical id', !!survivor);
	check('survivor keeps both source notes',
		!!survivor && survivor.sourceNotes.length === 2 && survivor.sourceNotes.includes('b.md'),
		JSON.stringify(survivor?.sourceNotes));
	check('the better description wins', survivor?.properties.description === 'a longer description');
	check('earliest createdAt is kept', survivor?.createdAt === 100, String(survivor?.createdAt));
	// The duplicate's own spelling is the same string once composed, so it must
	// NOT be recorded as a redundant alias of itself.
	check('no self-alias is created',
		!survivor?.properties.aliases || (survivor.properties.aliases as string[]).length === 0,
		JSON.stringify(survivor?.properties.aliases));

	check('duplicate edges collapse and self-loops are dropped',
		cache.getAllEdges().length === 1, String(cache.getAllEdges().length));
	check('the surviving edge points at the canonical id',
		cache.getAllEdges()[0]?.source === normalizeKey(nfcId));
	check('no edge references the stale id',
		cache.getAllEdges().every(e => e.source !== nfdId && e.target !== nfdId));

	// Lookups work through either spelling
	check('lookup by NFC name', cache.getNodeByName(NFC)?.id === normalizeKey(nfcId));
	check('lookup by NFD name', cache.getNodeByName(NFD)?.id === normalizeKey(nfcId));

	// --- search: the headline Korean feature ---
	check('plain search finds the NFD spelling', searchGraphCache(cache, NFD).length > 0);
	const viaTools = searchNodes(cache, NFD);
	check('bigram search finds it via the other form', viaTools.length > 0, JSON.stringify(viaTools.map(r => r.name)));
	check('bigram search scores it as an exact match',
		viaTools[0]?.score === 1, String(viaTools[0]?.score));

	// --- idempotence: a second load must be a no-op ---
	const canonical = cache.getGraphData();
	const again = new GraphCache(fakePlugin(canonical).plugin);
	await again.ensureLoaded();
	check('re-loading a canonical graph merges nothing', again.getMergedDuplicateCount() === 0);
	check('re-loading preserves nodes and edges',
		again.getAllNodes().length === canonical.nodes.length && again.getAllEdges().length === canonical.edges.length);

	console.log(fail === 0 ? 'korean: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
