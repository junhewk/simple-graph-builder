/**
 * SearchOptions.reached: what the graph walk found beyond the text matches
 * must survive however many text matches there are.
 *
 * The fixture is the case that broke the graph view's search: more entities
 * match the query by name than the result limit, so the shared ranking had
 * no room left for anything reached through the graph.
 */
import { QueryEngine } from '../src/query/engine';
import type { GraphReader, NoteRecord, VaultSource } from '../src/query/types';
import type { OntologyEdge, OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const N = 60;
const files = new Map<string, string>();
const nodes: OntologyNode[] = [];
const edges: OntologyEdge[] = [];
const node = (id: string, name: string, type: string, sourceNotes: string[]): OntologyNode =>
	({ id, entityType: type as never, properties: { name }, sourceNotes });

// Alpha i matches "alpha" by name; Beta i doesn't, and is one relation away.
// Each pair is written up in a note that never says "alpha".
const hubNotes: string[] = [];
for (let i = 0; i < N; i++) {
	const alphaNote = `A/alpha ${i}.md`;
	const betaNote = `B/beta ${i}.md`;
	files.set(alphaNote, `Alpha ${i} is studied here.`);
	files.set(betaNote, `Beta ${i} findings, recorded separately.`);
	hubNotes.push(alphaNote, betaNote);
	nodes.push(node(`concept:alpha ${i}`, `Alpha ${i}`, 'CONCEPT', [alphaNote]));
	nodes.push(node(`concept:beta ${i}`, `Beta ${i}`, 'CONCEPT', [betaNote]));
	edges.push({ id: `ab${i}`, source: `concept:alpha ${i}`, target: `concept:beta ${i}`, relationship: 'leads to', properties: {} });
}
// A hub everything touches, mentioned in every note: the walk reaches it from
// every seed, which is exactly why it is not a discovery
nodes.push(node('tool:hub', 'Hub', 'TOOL', hubNotes));
for (let i = 0; i < N; i++) {
	edges.push({ id: `ha${i}`, source: 'tool:hub', target: `concept:alpha ${i}`, relationship: 'indexes', properties: {} });
	edges.push({ id: `hb${i}`, source: 'tool:hub', target: `concept:beta ${i}`, relationship: 'indexes', properties: {} });
}

const source: VaultSource = {
	listMarkdownPaths: () => [...files.keys()],
	isVisible: () => true,
	readNote: async (p): Promise<NoteRecord | null> => {
		const body = files.get(p);
		return body === undefined ? null : { title: p.split('/').pop()!.replace(/\.md$/, ''), aliases: [], tags: [], headings: [], body };
	},
	readContent: async p => files.get(p) ?? null,
	resolvedLinks: () => ({}),
	resolveLinktext: () => null,
	noteMeta: () => ({ tags: [], aliases: [] }),
};
const graph: GraphReader = { getRevision: () => 1, getAllNodes: () => nodes, getAllEdges: () => edges };

(async () => {
	const engine = new QueryEngine(graph, source, { yieldFn: async () => undefined });
	await engine.ensureIndexed();

	const plain = await engine.search('alpha', { limit: 30, snippets: false });
	check('baseline: text matches fill the shared limit',
		plain.entities.length === 30 && plain.entities.every(h => h.match !== 'graph'),
		plain.entities.map(h => h.match).join(','));
	check('no reached list unless asked for', plain.reached === undefined);

	const res = await engine.search('alpha', { limit: 30, snippets: false, reached: 15 });
	const reached = res.reached!;
	check('reached entities are returned despite the crowded limit', reached.entities.length === 15, String(reached.entities.length));
	check('reached entities exclude text matches',
		reached.entities.every(h => !h.name.startsWith('Alpha')), reached.entities.map(h => h.name).join(', '));
	check('reached entities are the neighbours one relation away',
		reached.entities.filter(h => h.name.startsWith('Beta')).length >= 14, reached.entities.map(h => h.name).join(', '));
	check('the hub is damped below the specific neighbours',
		reached.entities.findIndex(h => h.id === 'tool:hub') !== 0, reached.entities.map(h => h.name).join(', '));
	check('reached scores are relative within the list',
		reached.entities[0].score === 1 && reached.entities.every(h => h.score > 0 && h.score <= 1));
	check('reached entities are marked as graph matches', reached.entities.every(h => h.match === 'graph'));

	check('reached notes are returned', reached.notes.length === 15, String(reached.notes.length));
	check('reached notes exclude notes matching the words',
		reached.notes.every(h => h.path.startsWith('B/')), reached.notes.map(h => h.path).join(', '));
	check('reached notes say which match connects them',
		reached.notes.every(h => h.connections.length > 0));

	const typed = await engine.search('alpha', { limit: 30, snippets: false, reached: 15, types: ['TOOL'] });
	check('type filter applies to reached entities',
		typed.reached!.entities.every(h => h.type === 'TOOL'), typed.reached!.entities.map(h => h.type).join(','));

	const notesOnly = await engine.search('alpha', { limit: 30, snippets: false, reached: 15, mode: 'notes' });
	check('mode limits the reached kinds too', notesOnly.reached!.entities.length === 0 && notesOnly.reached!.notes.length > 0);

	const nothing = await engine.search('zzzz', { limit: 30, reached: 15 });
	check('no seeds, no reached list', nothing.reached === undefined);

	console.log(fail ? `\n${fail} failed` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
