/**
 * Renaming a note must carry its provenance along.
 *
 * Before 0.7.0 nothing listened for renames, so sourceNotes and edge evidence
 * kept pointing at the old path. The query engine only serves what it can see
 * a source for, so those entities would have silently vanished from search.
 */
import { fakePluginWithData } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { rebuildNoteLayer, generateNoteNodeId } from '../src/graph/merge';
import type { GraphData } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const app = { metadataCache: { getFirstLinkpathDest: () => null, resolvedLinks: {} } } as never;

async function main() {
	const { plugin, latest } = fakePluginWithData();
	const cache = new GraphCache(plugin);
	await cache.ensureLoaded();
	cache.addNode({ id: 'concept:a', entityType: 'CONCEPT', properties: { name: 'A', entityNotePath: 'Entities/A.md' }, sourceNotes: ['old/note.md', 'other.md'] });
	cache.addNode({ id: 'concept:b', entityType: 'CONCEPT', properties: { name: 'B' }, sourceNotes: ['old/note.md'] });
	cache.addEdge({ id: 'a->b', source: 'concept:a', target: 'concept:b', relationship: 'uses', properties: {}, sourceNote: 'old/note.md' });
	rebuildNoteLayer(cache, app);
	check('note layer present for the old path', !!cache.getNodeById(generateNoteNodeId('old/note.md')));

	const moved = cache.renameSourceNote('old/note.md', 'new/note.md');
	check('two entities moved', moved.nodes === 2, JSON.stringify(moved));
	check('one evidence edge moved', moved.edges === 1, JSON.stringify(moved));
	check('sourceNotes follow the rename', cache.getNodeById('concept:a')?.sourceNotes.join() === 'new/note.md,other.md');
	check('index follows the rename', cache.getNodesBySourceNote('new/note.md').length === 2 && cache.getNodesBySourceNote('old/note.md').length === 0);
	check('edge evidence follows', cache.getEdgeById('a->b')?.sourceNote === 'new/note.md' && cache.getEdgesBySourceNote('new/note.md').length === 1);
	check('stale NOTE node dropped', !cache.getNodeById(generateNoteNodeId('old/note.md')));
	check('entity names still resolve', cache.getNodeByName('A')?.id === 'concept:a');

	rebuildNoteLayer(cache, app);
	check('note layer rebuilt for the new path', !!cache.getNodeById(generateNoteNodeId('new/note.md')));

	cache.renameSourceNote('Entities/A.md', 'Entities/Renamed A.md');
	check('entity note path follows', cache.getNodeById('concept:a')?.properties.entityNotePath === 'Entities/Renamed A.md');

	check('unrelated rename is a no-op', JSON.stringify(cache.renameSourceNote('x.md', 'y.md')) === '{"nodes":0,"edges":0}');

	await cache.flush();
	const saved = (latest() as { graph: GraphData }).graph;
	check('rename persisted', saved.nodes.find(n => n.id === 'concept:b')?.sourceNotes[0] === 'new/note.md');

	console.log(fail === 0 ? 'rename: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
