/**
 * Import, edit, update, remove: the whole cycle against an in-memory vault.
 *
 * This is the person's experience of the feature. A first import lands pages
 * with working wikilinks and joins the graph; a later snapshot updates what
 * they did not touch and keeps what they did; removing the import takes back
 * exactly what it brought.
 */
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';

// The import yields to real timers (the link-index wait), so restore them.
{
	const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
	w.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms ?? 0);
	w.clearTimeout = (id: NodeJS.Timeout) => clearTimeout(id);
}

import { executeImport, prepareFromReader, removeImport, rebuildImportGraph } from '../src/import/controller';
import { ImportRegistry } from '../src/import/registry';
import { getAnalysisEligibility } from '../src/analysis/exclusions';
import { writeRelatedProperty } from '../src/sync/related';
import { upsertEntityNotes } from '../src/sync/entity-notes';
import { nodeMedLit } from '../src/import/node-props';
import type { ImportManifest } from '../src/import/types';
import { buildProject, FixtureProject } from './medlit-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const v1: FixtureProject = {
	name: 'LLM interviews',
	botUpdate: 1,
	updatedAt: '2026-09-30T00:00:00+00:00',
	entities: [
		{ id: 1, name: 'Large language models', type: 'TECHNOLOGY', sgb: 'TOOL', description: 'med-lit LLM', aliases: [['LLM', 'acronym']] },
		{ id: 2, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT', description: 'v1' },
		{ id: 3, name: 'Chatbot', type: 'TECHNOLOGY', sgb: 'TOOL' },
	],
	articles: [{ uid: 'pmc:1', title: 'Kim 2026 - Chatbots', mentions: [[1, 'intervention'], [2, 'outcome'], [3, null]] }],
	relationships: [
		{ id: 1, source: 1, target: 2, verb: 'may erode', evidence: [['pmc:1', 'LLMs may erode empathy.']] },
		{ id: 2, source: 3, target: 2, verb: 'trains', evidence: [['pmc:1', 'q']] },
	],
};

const v2: FixtureProject = {
	...v1,
	botUpdate: 2,
	updatedAt: '2026-10-01T00:00:00+00:00',
	entities: [
		{ id: 1, name: 'Large language models', type: 'TECHNOLOGY', sgb: 'TOOL', description: 'med-lit LLM', aliases: [['LLM', 'acronym']] },
		{ id: 2, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT', description: 'v2, re-synthesized' },
		{ id: 4, name: 'Feedback', type: 'CONCEPT', sgb: 'CONCEPT' },
	],
	articles: [
		{ uid: 'pmc:1', title: 'Kim 2026 - Chatbots', mentions: [[1, 'intervention'], [2, 'outcome']] },
		{ uid: 'pmc:2', title: 'Lee 2026 - Feedback', mentions: [[1, null], [4, 'outcome']] },
	],
	relationships: [
		{ id: 1, source: 1, target: 2, verb: 'may erode', evidence: [['pmc:1', 'LLMs may erode empathy.']] },
		{ id: 3, source: 1, target: 4, verb: 'gives', evidence: [['pmc:2', 'LLMs give feedback.']] },
	],
};

const F = 'LLM interviews';

(async () => {
	const { plugin, vault, graphCache, latest } = fakeSyncPlugin({ enableEntityNotes: true, enableRelatedWriteback: true });
	const p = plugin as unknown as Record<string, unknown>;
	p.imports = new ImportRegistry();
	p.manifest = { dir: '.obsidian/plugins/simple-graph-builder' };
	p.updateStatusBar = () => undefined;
	await graphCache.ensureLoaded();

	// The vault before: one native note and its entity.
	vault.seed('notes/ai.md', 'I use an LLM for interview practice.');
	graphCache.addNode({ id: 'tool:llm', entityType: 'TOOL', properties: { name: 'LLM', description: 'mine' }, sourceNotes: ['notes/ai.md'] });

	// --- first import ---
	const prep1 = await prepareFromReader(plugin, buildProject(v1), '/src/bot');
	check('folder defaults to the project name, at the vault root', prep1.plan.folder === F);
	const r1 = await executeImport(plugin, prep1, { useEmbeddings: false });
	check('pages written', r1.counts.create === prep1.plan.actions.length && vault.files.has(`${F}/entities/Empathy.md`));
	const sourcePage = vault.bodies.get(`${F}/sources/Kim 2026 - Chatbots.md`)!;
	check('links are vault wikilinks', sourcePage.includes(`[[${F}/entities/Empathy|Empathy]]`) && !sourcePage.includes('](../'), sourcePage);
	check('imported LLM joins the native node', r1.graph.nodesShared === 1 && !!nodeMedLit(graphCache.getNodeById('tool:llm')!)['proj1']);
	check('manifest saved with the graph', !!(latest() as { imports?: Record<string, ImportManifest> }).imports?.proj1);
	check('graph copy stored for rebuilds', vault.adapterFiles.has('.obsidian/plugins/simple-graph-builder/med-lit/proj1.kg.json'));

	const imported = vault.files.get(`${F}/sources/Kim 2026 - Chatbots.md`)!;
	check('imported pages are not sent to the LLM', getAnalysisEligibility(plugin, imported).status === 'excluded');
	check('native notes still are', getAnalysisEligibility(plugin, vault.files.get('notes/ai.md')!).status === 'allowed');
	check('no related: written into imported pages', !(await writeRelatedProperty(plugin, imported)));

	await upsertEntityNotes(plugin, graphCache.getAllNodes());
	check('no entity notes for import-only entities', ![...vault.files.keys()].some(k => k.startsWith('Entities/Empathy')));
	const llmNote = [...vault.files.keys()].find(k => k.startsWith('Entities/LLM'));
	check('shared entity gets its entity note', !!llmNote);
	check('entity note links to the wiki page', !!llmNote && vault.bodies.get(llmNote)!.includes(`[[${F}/entities/Empathy`), llmNote && vault.bodies.get(llmNote));

	// --- the person edits, then the bot runs again ---
	const empathyPath = `${F}/entities/Empathy.md`;
	await vault.process(vault.files.get(empathyPath)!, text => text + '\nMy own note on empathy.\n');
	const prep2 = await prepareFromReader(plugin, buildProject(v2), '/src/bot');
	check('second read is an update', prep2.plan.isUpdate && !prep2.plan.older);
	const r2 = await executeImport(plugin, prep2, { useEmbeddings: false });
	check('edited page kept and reported', vault.bodies.get(empathyPath)!.includes('My own note') && r2.outcomes.some(o => o.path === empathyPath && o.kind === 'conflict'));
	check('new pages arrive', vault.files.has(`${F}/sources/Lee 2026 - Feedback.md`) && vault.files.has(`${F}/entities/Feedback.md`));
	check('page gone upstream goes to the trash', vault.stats.trashed.includes(`${F}/entities/Chatbot.md`));
	check('changed page updated', !vault.bodies.get(`${F}/sources/Kim 2026 - Chatbots.md`)!.includes('Chatbot]]'));
	check('entity gone upstream leaves the graph', !graphCache.getNodeById('tool:chatbot'));
	check('new entity joins the graph', !!graphCache.getNodeById('concept:feedback'));
	check('earlier matches reused', r2.reused === 2, String(r2.reused));

	const r3 = await executeImport(plugin, await prepareFromReader(plugin, buildProject(v2), '/src/bot'), { useEmbeddings: false });
	check('same snapshot again: nothing written', r3.counts.create + r3.counts.overwrite + r3.counts.trash === 0 && r3.graph.nodesCreated === 0, JSON.stringify(r3.counts));
	check('the conflict is still reported', r3.counts.conflict === 1);

	// --- "use med-lit's version" ---
	const forced = await prepareFromReader(plugin, buildProject(v2), '/src/bot', { force: new Set(['entity:2']) });
	await executeImport(plugin, forced, { useEmbeddings: false });
	check('forced page replaced', vault.bodies.get(empathyPath)!.includes('v2, re-synthesized') && !vault.bodies.get(empathyPath)!.includes('My own note'));

	// --- older snapshot ---
	const older = await prepareFromReader(plugin, buildProject(v1), '/src/bot');
	check('older snapshot flagged before anything is written', older.plan.older);

	// --- rename in Obsidian, then update ---
	const kim = `${F}/sources/Kim 2026 - Chatbots.md`;
	const moved = 'Reading/Kim.md';
	await vault.rename(vault.files.get(kim)!, moved);
	plugin.imports.renamePath(kim, moved);
	graphCache.renameSourceNote(kim, moved);
	const afterMove = await executeImport(plugin, await prepareFromReader(plugin, buildProject(v2), '/src/bot'), { useEmbeddings: false });
	check('moved page not recreated', !vault.files.has(kim) && afterMove.counts.create === 0);
	check('graph follows the move', graphCache.getNodeById('tool:llm')!.sourceNotes.includes(moved));
	check('other pages now link to the new path', vault.bodies.get(`${F}/entities/Large language models.md`)!.includes('[[Reading/Kim|pmc:1]]'));
	check('no page links to the old path', ![...vault.bodies.values()].some(b => b.includes(`[[${F}/sources/Kim 2026`)));

	// --- Clear graph, then rebuild from the stored copy ---
	const nodesBefore = graphCache.getStats().nodes;
	for (const node of graphCache.getAllNodes()) if (node.id !== 'tool:llm') graphCache.removeNode(node.id);
	await rebuildImportGraph(plugin, 'proj1');
	check('rebuild restores the project graph', graphCache.getStats().nodes >= nodesBefore - 1, `${graphCache.getStats().nodes} vs ${nodesBefore}`);

	// --- remove ---
	await vault.process(vault.files.get(`${F}/log.md`)!, text => text + '\nmine\n');
	const removed = await removeImport(plugin, 'proj1', { trashFiles: true });
	check('edited page kept on removal', vault.files.has(`${F}/log.md`) && removed.kept.includes(`${F}/log.md`));
	check('untouched pages trashed', !vault.files.has(`${F}/entities/Feedback.md`));
	const left = graphCache.getAllNodes().filter(n => n.entityType !== 'NOTE');
	check('graph back to the native entity', left.length === 1 && left[0].id === 'tool:llm' && !left[0].properties.medLit, left.map(n => n.id).join());
	check('native provenance intact', left[0].sourceNotes.length === 1 && left[0].sourceNotes[0] === 'notes/ai.md' && left[0].properties.description === 'mine');
	check('import forgotten', !plugin.imports.get('proj1') && !vault.adapterFiles.has('.obsidian/plugins/simple-graph-builder/med-lit/proj1.kg.json'));

	console.log(fail === 0 ? 'medlit-import: all checks passed' : `medlit-import: ${fail} FAILURES`);
	process.exit(fail === 0 ? 0 : 1);
})();
