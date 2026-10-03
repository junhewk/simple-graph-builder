/**
 * A real med-lit project, end to end through everything but the vault.
 *
 * Opt-in: set MEDLIT_SNAPSHOT to a project folder (one containing .med-lit/).
 * Without it the suite passes trivially, so `npm test` stays hermetic.
 *
 *   MEDLIT_SNAPSHOT="/path/to/LLM student interviews (bot 2)" npm test -- medlit-real
 */
import './graph-harness';
import { fakePlugin } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { readMedLitSnapshot } from '../src/import/snapshot';
import { planFiles } from '../src/import/plan';
import { reconcileProjectGraph } from '../src/import/reconcile';
import { resolveProjectEntities } from '../src/import/resolve';
import { DEFAULT_SETTINGS } from '../src/settings';
import { diskReader } from './medlit-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

(async () => {
	const root = process.env.MEDLIT_SNAPSHOT;
	if (!root) {
		console.log('medlit-real: skipped (set MEDLIT_SNAPSHOT)');
		return;
	}

	const snap = await readMedLitSnapshot(diskReader(root));
	console.log(`  ${snap.project.name}: ${snap.kg.articleUids.length} articles, ${snap.kg.entities.length} entities, ` +
		`${snap.kg.relationships.length} relationships, ${snap.kg.mentions.length} mentions, ${snap.files.length} pages`);
	for (const w of snap.warnings) console.log(`  warning: ${w}`);

	const entityPages = snap.files.filter(f => f.key.startsWith('entity:')).length;
	const sourcePages = snap.files.filter(f => f.key.startsWith('source:')).length;
	check('every entity has a page', entityPages === snap.kg.entities.length, `${entityPages} pages`);
	check('every article has a page', sourcePages === snap.kg.articleUids.length, `${sourcePages} pages`);
	check('every entity typed by med-lit', !snap.warnings.some(w => /sgb_type|no page/.test(w)));

	const folder = snap.project.name;
	const plan = await planFiles({ manifest: null, snapshot: snap, folder, read: async () => null });
	check('first import creates every page', plan.actions.every(a => a.kind === 'create'));

	// No relative link into the project survives the rewrite.
	const leftover: string[] = [];
	for (const action of plan.actions) {
		for (const m of action.content!.matchAll(/\]\(([^)\s]+\.md)\)/g)) leftover.push(`${action.rel}: ${m[1]}`);
	}
	check('all relative links rewritten', leftover.length === 0, leftover.slice(0, 3).join(' | '));

	const allPaths = new Set(plan.actions.map(a => a.path.replace(/\.md$/, '')));
	const dangling: string[] = [];
	for (const action of plan.actions) {
		for (const m of action.content!.matchAll(/\[\[([^\]|#]+)/g)) {
			if (m[1].includes('/') && !allPaths.has(m[1])) dangling.push(`${action.rel}: ${m[1]}`);
		}
	}
	check('every full-path wikilink lands on an imported page', dangling.length === 0, dangling.slice(0, 3).join(' | '));
	const bare = plan.actions.filter(a => a.rel.startsWith('updates/')).flatMap(a => [...a.content!.matchAll(/\[\[([^\]|/]+)\]\]/g)].map(m => m[1]));
	check('bot report links qualified', bare.length === 0, bare.slice(0, 5).join(', '));

	const sample = plan.actions.find(a => a.key.startsWith('source:'))!;
	console.log('  sample: ' + (sample.content!.match(/\[\[[^\]]+\]\]/)?.[0] ?? '(no link)'));

	// Graph: into an empty cache, then again -- the second run must change nothing.
	const cache = new GraphCache(fakePlugin().plugin);
	await cache.ensureLoaded();
	const files = Object.fromEntries(plan.actions.map(a => [a.key, a.path]));
	const resolved = await resolveProjectEntities(cache, DEFAULT_SETTINGS, snap.kg, {}, { useEmbeddings: false });
	const input = {
		projectId: snap.project.id,
		kg: snap.kg,
		entityMap: resolved.entityMap,
		pathOf: (key: string) => files[key],
		ownedPaths: Object.values(files),
	};
	const first = reconcileProjectGraph(cache, input);
	console.log(`  graph: ${first.nodesCreated} nodes, ${first.edgesCreated} edges created`);
	check('one node per entity', first.nodesCreated === snap.kg.entities.length, String(first.nodesCreated));
	const stats1 = cache.getStats();
	const second = reconcileProjectGraph(cache, input);
	const stats2 = cache.getStats();
	check('reconcile is idempotent', second.nodesCreated === 0 && second.edgesCreated === 0 && second.edgesRemoved === 0 &&
		second.nodesRemoved === 0 && stats1.nodes === stats2.nodes && stats1.edges === stats2.edges);
	check('every node sourced from imported pages', cache.getAllNodes().every(n => n.sourceNotes.every(p => p.startsWith(`${folder}/`))));

	const removed = reconcileProjectGraph(cache, { ...input, kg: null });
	check('removal empties the graph', cache.getStats().nodes === 0 && cache.getStats().edges === 0, JSON.stringify(removed));

	console.log(fail === 0 ? 'medlit-real: all checks passed' : `medlit-real: ${fail} FAILURES`);
	process.exit(fail === 0 ? 0 : 1);
})();
