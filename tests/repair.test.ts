/**
 * Loading a graph damaged by the old wikilink cross product must repair it.
 *
 * Shipping the note-layer fix alone isn't enough: the junk edges are already
 * persisted. One real vault carried 188,097 of them in a 115 MB data.json, so
 * the cleanup has to happen on load, in bulk, without the user doing anything.
 */
import { fakePlugin } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { GRAPH_SCHEMA_VERSION, OntologyEdge, OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const ENTITIES = 40;

const nodes: OntologyNode[] = Array.from({ length: ENTITIES }, (_, i) => ({
	id: `concept:e${i}`,
	entityType: 'CONCEPT',
	properties: { name: `Entity ${i}` },
	sourceNotes: [i % 2 === 0 ? 'a.md' : 'b.md'],
}));

// The cross product the old pass produced: every entity of a.md against every
// entity of b.md, both directions.
const legacy: OntologyEdge[] = [];
for (let i = 0; i < ENTITIES; i += 2) {
	for (let j = 1; j < ENTITIES; j += 2) {
		legacy.push({
			id: `concept:e${i}->concept:e${j}:links to`,
			source: `concept:e${i}`,
			target: `concept:e${j}`,
			relationship: 'links to',
			properties: { detail: 'wikilink' },
			sourceNote: 'a.md',
		});
	}
}

// Real extracted relationships, which must survive untouched.
const semantic: OntologyEdge[] = [
	{ id: 's1', source: 'concept:e0', target: 'concept:e1', relationship: 'develops', properties: { detail: 'real' }, sourceNote: 'a.md' },
	{ id: 's2', source: 'concept:e2', target: 'concept:e3', relationship: 'cites', properties: {}, sourceNote: 'a.md' },
];

// A 'links to' edge WITHOUT the wikilink marker is note-layer output. It is no
// longer persisted at all -- it gets dropped on load and rebuilt from Obsidian's
// link index (see persist.test.ts) -- but it must not be counted as legacy junk.
const noteLayer: OntologyEdge = {
	id: 's3', source: 'note:a.md', target: 'note:b.md', relationship: 'links to', properties: {}, sourceNote: 'a.md',
};

async function main() {
	check('fixture reproduces a cross product', legacy.length === (ENTITIES / 2) * (ENTITIES / 2), String(legacy.length));

	const damaged = new GraphCache(fakePlugin({
		nodes,
		edges: [...legacy, ...semantic, noteLayer],
		version: 1, // real v3 graphs in the wild still claim version 1
	}).plugin);
	await damaged.ensureLoaded();

	const after = damaged.getAllEdges();
	check('every legacy wikilink edge is gone',
		after.every(e => e.properties?.detail !== 'wikilink'), String(after.length));
	check('all semantic edges survive',
		semantic.every(s => after.some(e => e.id === s.id)), String(after.length));
	check('the derived note-layer edge is dropped from storage', !after.find(e => e.id === 's3'));
	check('but it was not blamed on the legacy pass',
		damaged.getPrunedLegacyEdgeCount() === legacy.length, String(damaged.getPrunedLegacyEdgeCount()));
	check('only the semantic edges remain', after.length === semantic.length, String(after.length));
	check('pruned count is reported', damaged.getPrunedLegacyEdgeCount() === legacy.length,
		String(damaged.getPrunedLegacyEdgeCount()));
	check('nodes are untouched', damaged.getAllNodes().length === ENTITIES);

	// The bulk filter bypasses removeEdge, so the indexes must be rebuilt from
	// scratch afterwards -- a stale index would silently resurrect pruned edges.
	const indexed = new Set<string>();
	for (const node of damaged.getAllNodes()) {
		for (const e of damaged.getEdgesBySource(node.id)) indexed.add(e.id);
		for (const e of damaged.getEdgesByTarget(node.id)) indexed.add(e.id);
	}
	check('no pruned edge survives in the source/target indexes',
		[...indexed].every(id => after.some(e => e.id === id)), `${indexed.size} indexed`);
	check('surviving entity edges are all indexed',
		after.filter(e => e.source.startsWith('concept:')).every(e => indexed.has(e.id)));

	check('stored version is brought up to date',
		damaged.getGraphData().version === GRAPH_SCHEMA_VERSION, String(damaged.getGraphData().version));

	// A healthy graph must come through completely unchanged.
	const healthy = new GraphCache(fakePlugin({
		nodes,
		edges: semantic,
		version: GRAPH_SCHEMA_VERSION,
	}).plugin);
	await healthy.ensureLoaded();
	check('a clean graph loses nothing', healthy.getAllEdges().length === semantic.length,
		String(healthy.getAllEdges().length));
	check('a clean graph reports no pruning', healthy.getPrunedLegacyEdgeCount() === 0);

	console.log(fail === 0 ? 'repair: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
