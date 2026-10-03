/**
 * Merging an imported project into a graph that already has a life of its own.
 *
 * The imported graph must join the existing one (same entity, same node), never
 * damage it (native provenance survives every update and the removal), and
 * follow the project as it changes upstream.
 */
import './graph-harness';
import { fakePlugin } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { EntityResolver } from '../src/graph/resolver';
import { generateEdgeId, removeNoteFromCache } from '../src/graph/merge';
import { reconcileProjectGraph, ReconcileInput } from '../src/import/reconcile';
import { resolveProjectEntities } from '../src/import/resolve';
import { readMedLitSnapshot } from '../src/import/snapshot';
import { nodeMedLit, edgeMedLit } from '../src/import/node-props';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { MedLitKg } from '../src/import/types';
import type { OntologyNode } from '../src/types';
import { buildProject, FixtureProject } from './medlit-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const F = 'Review';
const native = (id: string, type: OntologyNode['entityType'], name: string, notes: string[], aliases?: string[]): OntologyNode => ({
	id, entityType: type, properties: { name, description: `native ${name}`, ...(aliases ? { aliases } : {}) }, sourceNotes: notes,
});

const project: FixtureProject = {
	entities: [
		{ id: 1, name: 'Large language models', type: 'TECHNOLOGY', sgb: 'TOOL', description: 'med-lit LLM', aliases: [['LLM', 'acronym']] },
		{ id: 2, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT', description: 'med-lit empathy' },
		{ id: 3, name: 'OSCE', type: 'METHOD', sgb: 'METHOD' },
		{ id: 4, name: 'Virtual patient', type: 'TECHNOLOGY', sgb: 'TOOL' },
	],
	articles: [
		{ uid: 'a:1', title: 'Kim 2026', mentions: [[1, 'intervention'], [2, 'outcome'], [4, null]] },
		{ uid: 'a:2', title: 'Lee 2026', mentions: [[1, null], [3, 'context']] },
	],
	relationships: [
		{ id: 1, source: 1, target: 2, verb: 'may erode', evidence: [['a:1', 'LLMs may erode empathy.']] },
		{ id: 2, source: 1, target: 3, verb: 'is evaluated with', evidence: [['a:2', 'q2'], ['a:1', 'q1']] },
		{ id: 3, source: 4, target: 2, verb: 'trains', evidence: [['a:1', 'VPs train empathy.']] },
	],
	merges: [[4, 9, 'Virtual patients']],
};

const pathsFor = (kg: MedLitKg, folder: string) => {
	const map: Record<string, string> = {};
	for (const e of kg.entities) map[`entity:${e.id}`] = `${folder}/entities/${e.name}.md`;
	return map;
};

async function setup(p: FixtureProject, extraPaths: Record<string, string> = {}) {
	const snap = await readMedLitSnapshot(buildProject(p));
	const paths: Record<string, string> = { ...pathsFor(snap.kg, F), ...extraPaths };
	for (const f of snap.files) paths[f.key] ??= `${F}/${f.rel}`;
	return { snap, paths };
}

(async () => {
	const cache = new GraphCache(fakePlugin().plugin);
	await cache.ensureLoaded();

	// The user's own graph: "LLM" from their notes (a TOOL), "Empathy" typed
	// differently, an unrelated "Virtual patients" node, and a native edge the
	// project will also assert.
	cache.addNode(native('tool:llm', 'TOOL', 'LLM', ['notes/ai.md']));
	cache.addNode(native('topic:empathy', 'TOPIC', 'Empathy', ['notes/care.md']));
	cache.addNode(native('tool:virtual patients', 'TOOL', 'Virtual patients', ['notes/sim.md']));
	const nativeEdge = generateEdgeId('tool:llm', 'topic:empathy', 'may erode');
	cache.addEdge({ id: nativeEdge, source: 'tool:llm', target: 'topic:empathy', relationship: 'may erode', properties: { detail: 'native' }, sourceNote: 'notes/ai.md' });
	const before = { nodes: cache.getStats().nodes, edges: cache.getStats().edges };

	const { snap, paths } = await setup(project);
	const resolved = await resolveProjectEntities(cache, DEFAULT_SETTINGS, snap.kg, {}, { useEmbeddings: false });
	check('acronym alias matches the native node of the same type', resolved.entityMap['1'] === 'tool:llm');
	check('exact name matches across types', resolved.entityMap['2'] === 'topic:empathy');
	check('unmatched entity gets its own id', resolved.entityMap['3'] === 'method:osce');

	const allPaths = Object.values(paths);
	const input: ReconcileInput = {
		projectId: 'p1', kg: snap.kg, entityMap: resolved.entityMap,
		pathOf: key => paths[key], ownedPaths: allPaths,
	};
	const r1 = reconcileProjectGraph(cache, input);
	check('two nodes created, two shared', r1.nodesCreated === 2 && r1.nodesShared === 2, JSON.stringify(r1));

	const llm = cache.getNodeById('tool:llm')!;
	check('shared node keeps its native type and name', llm.entityType === 'TOOL' && llm.properties.name === 'LLM');
	check('shared node keeps its native note', llm.sourceNotes.includes('notes/ai.md'));
	check('shared node gains the article pages', llm.sourceNotes.includes(`${F}/sources/Kim 2026.md`) && llm.sourceNotes.includes(`${F}/sources/Lee 2026.md`));
	check('shared node learns the med-lit name as an alias', (llm.properties.aliases ?? []).includes('Large language models'));
	check('native description not replaced', llm.properties.description === 'native LLM');
	check('provenance records the wiki page', nodeMedLit(llm).p1?.pages[0] === `${F}/entities/Large language models.md`);
	check('alias index works for the new alias', cache.getNodeByNameOrAlias('large language models')?.id === 'tool:llm');

	const osce = cache.getNodeById('method:osce')!;
	check('new node typed by med-lit', osce.entityType === 'METHOD');
	check('new node sourced from its article', osce.sourceNotes.length === 1 && osce.sourceNotes[0] === `${F}/sources/Lee 2026.md`);

	const shared = cache.getEdgeById(nativeEdge)!;
	check('native edge keeps its own evidence note', shared.sourceNote === 'notes/ai.md' && shared.properties.detail === 'native');
	check('native edge gains the project quotes', edgeMedLit(shared).p1?.evidence[0]?.quote === 'LLMs may erode empathy.');
	check('reported as shared, not created', r1.edgesShared === 1);

	const evaluated = cache.getEdgeById(generateEdgeId('tool:llm', 'method:osce', 'is evaluated with'))!;
	check('new edge cites the first article page', evaluated.sourceNote === `${F}/sources/Kim 2026.md`);
	check('new edge keeps every quote', edgeMedLit(evaluated).p1?.evidence.length === 2);

	check('merge med-lit made is suggested, not applied', r1.suggestedMerges.length === 1 && r1.suggestedMerges[0].other === 'tool:virtual patients');

	// --- idempotent ---
	const stats1 = JSON.stringify(cache.getAllNodes().map(n => [n.id, n.sourceNotes, n.properties.aliases]));
	const r2 = reconcileProjectGraph(cache, input);
	const stats2 = JSON.stringify(cache.getAllNodes().map(n => [n.id, n.sourceNotes, n.properties.aliases]));
	check('second run changes nothing', stats1 === stats2 && r2.nodesCreated + r2.nodesRemoved + r2.edgesCreated + r2.edgesRemoved === 0);

	// --- the user merges two nodes by hand, then the project updates ---
	new EntityResolver(cache, DEFAULT_SETTINGS).mergeEntities('tool:virtual patient', 'tool:virtual patients');
	const reresolved = await resolveProjectEntities(cache, DEFAULT_SETTINGS, snap.kg, resolved.entityMap, { useEmbeddings: false });
	check('a hand merge is followed on update', reresolved.entityMap['4'] === 'tool:virtual patients', reresolved.entityMap['4']);
	check('earlier matches are reused', reresolved.reused === 3);
	reconcileProjectGraph(cache, { ...input, entityMap: reresolved.entityMap });
	const vp = cache.getNodeById('tool:virtual patients')!;
	check('merge target carries the project', !!nodeMedLit(vp).p1 && vp.sourceNotes.includes('notes/sim.md'));

	// --- upstream: article a:2 withdrawn ---
	const withdrawn: FixtureProject = {
		...project,
		entities: project.entities.filter(e => e.id !== 3),
		articles: project.articles.filter(a => a.uid !== 'a:2'),
		relationships: [project.relationships[0], { ...project.relationships[1], evidence: [['a:1', 'q1']], target: 2, verb: 'is studied with' }, project.relationships[2]],
	};
	const w = await setup(withdrawn);
	const wInput: ReconcileInput = {
		projectId: 'p1', kg: w.snap.kg, entityMap: reresolved.entityMap,
		pathOf: key => w.paths[key], ownedPaths: [...allPaths, ...Object.values(w.paths)],
	};
	const r3 = reconcileProjectGraph(cache, wInput);
	check('withdrawn-only entity removed', !cache.getNodeById('method:osce'), JSON.stringify(r3));
	check('its edge removed', !cache.getEdgeById(generateEdgeId('tool:llm', 'method:osce', 'is evaluated with')));
	check('withdrawn page no longer a source', !cache.getNodeById('tool:llm')!.sourceNotes.includes(`${F}/sources/Lee 2026.md`));
	check('native note still a source', cache.getNodeById('tool:llm')!.sourceNotes.includes('notes/ai.md'));
	check('index has no stale entries for the withdrawn page', cache.getNodesBySourceNote(`${F}/sources/Lee 2026.md`).length === 0);

	// --- a second project shares an edge ---
	const other: FixtureProject = {
		id: 'proj2',
		entities: [
			{ id: 1, name: 'Large language models', type: 'TECHNOLOGY', sgb: 'TOOL' },
			{ id: 2, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT' },
		],
		articles: [{ uid: 'b:1', title: 'Park 2026', mentions: [[1, null], [2, null]] }],
		relationships: [{ id: 1, source: 2, target: 1, verb: 'limits', evidence: [['b:1', 'other quote']] }],
	};
	const o = await setup(other);
	const oPaths: Record<string, string> = {};
	for (const [k, v] of Object.entries(o.paths)) oPaths[k] = v.replace(`${F}/`, 'Other/');
	const oMap = (await resolveProjectEntities(cache, DEFAULT_SETTINGS, o.snap.kg, {}, { useEmbeddings: false })).entityMap;
	const oInput: ReconcileInput = { projectId: 'p2', kg: o.snap.kg, entityMap: oMap, pathOf: k => oPaths[k], ownedPaths: Object.values(oPaths) };
	reconcileProjectGraph(cache, oInput);
	const limits = cache.getEdgeById(generateEdgeId('topic:empathy', 'tool:llm', 'limits'))!;
	check('second project edge created', limits.sourceNote === 'Other/sources/Park 2026.md');
	reconcileProjectGraph(cache, { ...oInput, kg: o.snap.kg }); // no-op
	check('both projects on one node', !!nodeMedLit(cache.getNodeById('tool:llm')!).p1 && !!nodeMedLit(cache.getNodeById('tool:llm')!).p2);

	// Removing a native note never drops an edge an import still vouches for.
	removeNoteFromCache(cache, 'notes/ai.md');
	const afterNativeRemoval = cache.getEdgeById(nativeEdge);
	check('import-backed edge survives removing its native note', afterNativeRemoval?.sourceNote === `${F}/sources/Kim 2026.md`, afterNativeRemoval?.sourceNote);
	cache.addNode({ ...native('tool:llm', 'TOOL', 'LLM', []), sourceNotes: [...cache.getNodeById('tool:llm')!.sourceNotes, 'notes/ai.md'] });
	cache.editNode(cache.getNodeById('tool:llm')!, n => { n.properties.description = 'native LLM'; });

	// --- take both projects out again ---
	reconcileProjectGraph(cache, { ...oInput, kg: null });
	reconcileProjectGraph(cache, { ...wInput, kg: null });
	const left = cache.getAllNodes().filter(n => n.entityType !== 'NOTE').map(n => n.id).sort();
	check('removal leaves only native nodes', JSON.stringify(left) === JSON.stringify(['tool:llm', 'tool:virtual patients', 'topic:empathy']), left.join());
	check('no project provenance left', cache.getAllNodes().every(n => !n.properties.medLit) && cache.getAllEdges().every(e => !e.properties.medLit));
	check('aliases the projects added are gone', !(cache.getNodeById('tool:llm')!.properties.aliases ?? []).includes('Large language models'));
	check('no edge cites a project page', cache.getAllEdges().every(e => !e.sourceNote?.startsWith(`${F}/`) && !e.sourceNote?.startsWith('Other/')));
	check('node count back to the start', cache.getStats().nodes === before.nodes, `${cache.getStats().nodes} vs ${before.nodes}`);

	console.log(fail === 0 ? 'medlit-reconcile: all checks passed' : `medlit-reconcile: ${fail} FAILURES`);
	process.exit(fail === 0 ? 0 : 1);
})();
