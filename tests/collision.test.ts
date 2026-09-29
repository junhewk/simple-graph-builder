/**
 * A note named like an entity must not shadow that entity.
 *
 * THE BUG: NOTE nodes are named after the note's basename and were indexed by
 * name after the entities, so `Transformer.md` replaced the entity
 * "Transformer" in the name index. Extraction of another note then merged its
 * "Transformer" into the NOTE node, and flush() -- which drops the note layer
 * -- threw those relationships away.
 */
import { fakePluginWithData } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { mergeExtractionIntoCache, rebuildNoteLayer, removeNoteFromCache, generateNoteNodeId } from '../src/graph/merge';
import type { GraphData } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const app = {
	metadataCache: {
		getFirstLinkpathDest: () => null,
		resolvedLinks: {},
	},
} as never;

async function main() {
	const { plugin, latest } = fakePluginWithData();
	const cache = new GraphCache(plugin);
	await cache.ensureLoaded();

	cache.addNode({
		id: 'concept:transformer',
		entityType: 'CONCEPT',
		properties: { name: 'Transformer', aliases: ['Transformer model'] },
		sourceNotes: ['Transformer.md'],
	});
	rebuildNoteLayer(cache, app);

	const noteId = generateNoteNodeId('Transformer.md');
	check('the NOTE node exists', !!cache.getNodeById(noteId));
	check('name lookup still finds the entity', cache.getNodeByName('Transformer')?.id === 'concept:transformer',
		cache.getNodeByName('Transformer')?.id);
	check('name-or-alias lookup finds the entity', cache.getNodeByNameOrAlias('transformer')?.id === 'concept:transformer');
	check('NOTE nodes cannot take aliases', !cache.addAliasToNode(noteId, 'Something'));

	// Extraction from another note must land on the entity, not the note.
	const revBefore = cache.getRevision();
	mergeExtractionIntoCache(cache, 'b.md', {
		nodes: [
			{ id: 't1', entityType: 'CONCEPT', properties: { name: 'Transformer', description: 'x' } },
			{ id: 't2', entityType: 'CONCEPT', properties: { name: 'Attention', description: 'y' } },
		],
		relationships: [{ source: 't2', target: 't1', relationship: 'powers', properties: {} }],
	});
	check('revision advances on change', cache.getRevision() > revBefore);
	const entity = cache.getNodeById('concept:transformer');
	check('extraction merged into the entity', !!entity?.sourceNotes.includes('b.md'), JSON.stringify(entity?.sourceNotes));
	check('the NOTE node did not absorb b.md', !cache.getNodeById(noteId)?.sourceNotes.includes('b.md'));

	// The relationship survives a save.
	await cache.flush();
	const saved = (latest() as { graph: GraphData }).graph;
	check('relationship persisted', saved.edges.some(e => e.target === 'concept:transformer' && e.relationship === 'powers'),
		JSON.stringify(saved.edges.map(e => e.id)));
	check('no persisted edge dangles', saved.edges.every(e =>
		saved.nodes.some(n => n.id === e.source) && saved.nodes.some(n => n.id === e.target)));

	// Removing the like-named note keeps the entity reachable by name.
	removeNoteFromCache(cache, 'Transformer.md');
	check('entity still found after its namesake note is removed',
		cache.getNodeByName('Transformer')?.id === 'concept:transformer');

	// Removing one of two same-alias entities must not orphan the other's key.
	cache.addNode({ id: 'tool:alpha', entityType: 'TOOL', properties: { name: 'Alpha', aliases: ['A1'] }, sourceNotes: ['x.md'] });
	cache.addNode({ id: 'tool:beta', entityType: 'TOOL', properties: { name: 'Beta', aliases: ['A1'] }, sourceNotes: ['y.md'] });
	cache.removeNode('tool:alpha');
	check('shared alias still resolves to the survivor', cache.getNodeByAlias('A1')?.id === 'tool:beta',
		cache.getNodeByAlias('A1')?.id);

	console.log(fail === 0 ? 'collision: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
