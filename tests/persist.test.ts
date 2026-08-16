/**
 * What reaches disk, and what an older data.json turns into on load.
 *
 * The note layer -- NOTE nodes, `mentions`, `links to` -- is derived twice over:
 * mentions restate node.sourceNotes, and links restate Obsidian's own
 * resolvedLinks. Persisting it doubled the file for nothing, so it is now
 * dropped on load and filtered on save.
 *
 * The risk in that change is data loss, so these checks care most about the
 * upgrade path: a file written by 0.5.x must load with its entity graph,
 * resolution cache, embedding index and hashes untouched, and must come back to
 * full strength in memory once the link index is available.
 */
import { fakePluginWithData } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { rebuildNoteLayer, removeNoteFromCache, generateNoteNodeId } from '../src/graph/merge';
import { isNoteNode, isNoteLayerEdge, GRAPH_SCHEMA_VERSION } from '../src/types';
import type { GraphData, OntologyEdge, OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const NOTES = ['a.md', 'b.md'];

const app = {
	metadataCache: {
		getFirstLinkpathDest: (target: string) => {
			const path = `${target}.md`;
			return NOTES.includes(path) ? { path } : null;
		},
		resolvedLinks: { 'a.md': { 'b.md': 1 }, 'b.md': {} },
	},
} as never;

const entityNodes: OntologyNode[] = [
	{ id: 'concept:machine learning', entityType: 'CONCEPT', properties: { name: 'Machine Learning' }, sourceNotes: ['a.md'] },
	{ id: 'person:geoffrey hinton', entityType: 'PERSON', properties: { name: 'Geoffrey Hinton' }, sourceNotes: ['a.md', 'b.md'] },
];
const entityEdge: OntologyEdge = {
	id: 'person:geoffrey hinton->concept:machine learning:develops',
	source: 'person:geoffrey hinton',
	target: 'concept:machine learning',
	relationship: 'develops',
	properties: {},
	sourceNote: 'a.md',
};

/** A data.json shaped the way the current release writes one. */
function legacyData() {
	const noteNodes: OntologyNode[] = NOTES.map(path => ({
		id: generateNoteNodeId(path),
		entityType: 'NOTE' as const,
		properties: { name: path.replace('.md', ''), path },
		sourceNotes: [path],
	}));
	const noteEdges: OntologyEdge[] = [
		{ id: 'note:a.md->concept:machine learning:mentions', source: 'note:a.md', target: 'concept:machine learning', relationship: 'mentions', properties: {}, sourceNote: 'a.md' },
		{ id: 'note:a.md->person:geoffrey hinton:mentions', source: 'note:a.md', target: 'person:geoffrey hinton', relationship: 'mentions', properties: {}, sourceNote: 'a.md' },
		{ id: 'note:b.md->person:geoffrey hinton:mentions', source: 'note:b.md', target: 'person:geoffrey hinton', relationship: 'mentions', properties: {}, sourceNote: 'b.md' },
		{ id: 'note:a.md->note:b.md:links to', source: 'note:a.md', target: 'note:b.md', relationship: 'links to', properties: {}, sourceNote: 'a.md' },
	];

	return {
		settings: { apiProvider: 'claude' },
		graph: {
			nodes: [...entityNodes, ...noteNodes],
			edges: [entityEdge, ...noteEdges],
			version: GRAPH_SCHEMA_VERSION,
		} as GraphData,
		hashes: { hashes: [{ path: 'a.md', hash: 'abc', analyzedAt: 1 }] },
		resolutionCache: { ml: 'concept:machine learning' },
		embeddingIndex: { nodeIds: ['concept:machine learning'], model: 'text-embedding-3-small', dimensions: 1536, updatedAt: 1 },
	};
}

/** What this version writes: entity graph only. */
function slimData() {
	return {
		settings: { apiProvider: 'claude' },
		graph: { nodes: [...entityNodes], edges: [entityEdge], version: GRAPH_SCHEMA_VERSION } as GraphData,
		hashes: { hashes: [] },
	};
}

async function main() {
	// --- upgrading from a file that has the note layer in it ---------------
	{
		const { plugin, latest } = fakePluginWithData(legacyData());
		const cache = new GraphCache(plugin);
		await cache.ensureLoaded();

		check('note nodes are dropped from memory on load', cache.getAllNodes().filter(isNoteNode).length === 0);
		check('note-layer edges are dropped from memory on load',
			cache.getAllEdges().filter(e => isNoteLayerEdge(e)).length === 0);
		check('entity nodes survive the load', cache.getAllNodes().length === 2, String(cache.getAllNodes().length));
		check('entity edges survive the load', cache.getAllEdges().length === 1, String(cache.getAllEdges().length));
		check('sourceNotes survive the load',
			cache.getNodeById('person:geoffrey hinton')?.sourceNotes.length === 2);

		await cache.flush();
		const saved = latest();
		const savedGraph = saved?.graph as GraphData;
		check('saved graph has no note nodes', savedGraph.nodes.every(n => !isNoteNode(n)), String(savedGraph.nodes.length));
		check('saved graph has no note-layer edges', savedGraph.edges.every(e => !isNoteLayerEdge(e)), String(savedGraph.edges.length));
		check('saved graph keeps the entity edge', savedGraph.edges.length === 1);

		// Everything else in the file must come through untouched.
		check('hashes are preserved', JSON.stringify(saved?.hashes) === JSON.stringify({ hashes: [{ path: 'a.md', hash: 'abc', analyzedAt: 1 }] }),
			JSON.stringify(saved?.hashes));
		check('resolution cache is preserved',
			(saved?.resolutionCache as Record<string, string>)?.ml === 'concept:machine learning');
		check('embedding index is preserved',
			(saved?.embeddingIndex as { model: string })?.model === 'text-embedding-3-small');
		check('settings are preserved', (saved?.settings as { apiProvider: string })?.apiProvider === 'claude');

		// And the layer must come back once Obsidian's link index is ready.
		const stats = rebuildNoteLayer(cache, app);
		check('rebuild restores note nodes', stats.noteNodesAdded === 2, String(stats.noteNodesAdded));
		check('rebuild restores mentions', cache.getAllEdges().filter(e => e.relationship === 'mentions').length === 3,
			String(cache.getAllEdges().filter(e => e.relationship === 'mentions').length));
		check('rebuild restores note links', cache.getAllEdges().filter(e => e.relationship === 'links to').length === 1);
		check('rebuilt graph matches what was on disk before the upgrade',
			cache.getAllNodes().length === 4 && cache.getAllEdges().length === 5,
			`${cache.getAllNodes().length} nodes, ${cache.getAllEdges().length} edges`);
	}

	// --- a legacy entity whose id starts with "note:" is not the note layer -
	{
		// v2 built ids from the LLM's free-form label, and models do label things
		// "Note" (labelToEntityType maps 'note' to DOCUMENT). Identifying the note
		// layer by the id prefix alone would delete this entity's real edges.
		const legacyEntity: OntologyNode = {
			id: 'note:attention is all you need',
			entityType: 'DOCUMENT',
			properties: { name: 'Attention Is All You Need' },
			sourceNotes: ['a.md'],
		};
		const realEdge: OntologyEdge = {
			id: 'note:attention is all you need->concept:machine learning:introduces',
			source: 'note:attention is all you need',
			target: 'concept:machine learning',
			relationship: 'introduces',
			properties: {},
			sourceNote: 'a.md',
		};

		const { plugin, latest } = fakePluginWithData({
			settings: {},
			graph: { nodes: [...entityNodes, legacyEntity], edges: [entityEdge, realEdge], version: GRAPH_SCHEMA_VERSION },
			hashes: { hashes: [] },
		});
		const cache = new GraphCache(plugin);
		await cache.ensureLoaded();

		check('a legacy note:-prefixed entity survives the load', !!cache.getNodeById('note:attention is all you need'));
		check('and keeps its relationships', !!cache.getEdgeById(realEdge.id),
			`${cache.getAllEdges().length} edges`);

		cache.addEdge({ ...realEdge, id: 'note:attention is all you need->person:geoffrey hinton:cites', target: 'person:geoffrey hinton', relationship: 'cites' });
		await cache.flush();
		const saved = (latest()?.graph as GraphData).edges;
		check('its relationships are persisted, not filtered out',
			saved.some(e => e.id === realEdge.id) && saved.length === 3, `${saved.length} edges saved`);
	}

	// --- a file already in the new shape must not be rewritten -------------
	{
		const { plugin, saved } = fakePluginWithData(slimData());
		const cache = new GraphCache(plugin);
		await cache.ensureLoaded();
		check('a slim file loads without pruning anything', cache.getAllNodes().length === 2);

		rebuildNoteLayer(cache, app);
		await cache.flush();
		check('rebuilding the note layer does not trigger a save', saved.length === 0, `${saved.length} saves`);
		check('but the layer is present in memory', cache.getAllNodes().filter(isNoteNode).length === 2);
	}

	// --- the note layer still behaves like part of the graph ---------------
	{
		const { plugin, latest } = fakePluginWithData(slimData());
		const cache = new GraphCache(plugin);
		await cache.ensureLoaded();
		rebuildNoteLayer(cache, app);

		removeNoteFromCache(cache, 'a.md');
		check('removing a note removes its NOTE node', !cache.getNodeById(generateNoteNodeId('a.md')));
		check('removing a note removes its mentions',
			cache.getAllEdges().filter(e => e.source === generateNoteNodeId('a.md')).length === 0);
		check('an entity sourced only by that note is gone', !cache.getNodeById('concept:machine learning'));
		check('an entity shared with another note stays', !!cache.getNodeById('person:geoffrey hinton'));

		await cache.flush();
		const savedGraph = latest()?.graph as GraphData;
		check('the save after a removal is still slim',
			savedGraph.nodes.every(n => !isNoteNode(n)) && savedGraph.edges.every(e => !isNoteLayerEdge(e)));
		check('removal reached disk', savedGraph.nodes.length === 1, String(savedGraph.nodes.length));
	}

	console.log(fail === 0 ? 'persist: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
