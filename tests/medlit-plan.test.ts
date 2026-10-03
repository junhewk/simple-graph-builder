/**
 * The file merge's decision table, one row at a time.
 *
 * Every row is a promise about someone's vault: an edited page is never
 * overwritten or trashed without being asked, a deleted page is not brought
 * back, and a re-run after a crash finds nothing left to do.
 */
import { planFiles, hashContent, FileActionKind } from '../src/import/plan';
import { readMedLitSnapshot } from '../src/import/snapshot';
import type { ImportManifest, ManifestFile } from '../src/import/types';
import { buildProject, FixtureProject } from './medlit-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const F = 'Review';
const v1: FixtureProject = {
	botUpdate: 1,
	updatedAt: '2026-09-30T00:00:00+00:00',
	entities: [
		{ id: 1, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT', description: 'v1 text' },
		{ id: 2, name: 'OSCE', type: 'METHOD', sgb: 'METHOD' },
		{ id: 3, name: 'Chatbot', type: 'TECHNOLOGY', sgb: 'TOOL' },
	],
	articles: [{ uid: 'pmc:1', title: 'Kim 2026', mentions: [[1, 'outcome'], [2, null], [3, 'intervention']] }],
	relationships: [{ id: 1, source: 3, target: 1, verb: 'trains', evidence: [['pmc:1', 'q']] }],
};

(async () => {
	// --- first import ---
	const snap1 = await readMedLitSnapshot(buildProject(v1));
	const empty = await planFiles({ manifest: null, snapshot: snap1, folder: F, read: async () => null });
	check('first import: everything created', empty.actions.every(a => a.kind === 'create'));
	check('first import: paths under the folder', empty.actions.every(a => a.path.startsWith(`${F}/`)));
	check('first import: not an update', !empty.isUpdate && !empty.older);

	// Simulate the vault right after that import.
	const vault = new Map<string, string>();
	const files: Record<string, ManifestFile> = {};
	for (const a of empty.actions) {
		vault.set(a.path, a.content!);
		files[a.key] = { path: a.path, rel: a.rel, baseHash: a.theirsHash! };
	}
	const manifest: ImportManifest = {
		version: 1, projectId: 'proj1', name: 'Test review', vaultFolder: F, lastSourcePath: '/x',
		importedAt: 0, marker: snap1.marker, files, entityMap: {},
	};
	const read = async (p: string) => vault.get(p) ?? null;

	const again = await planFiles({ manifest, snapshot: snap1, folder: 'ignored', read });
	check('same snapshot again: all unchanged', again.actions.every(a => a.kind === 'unchanged'), again.actions.map(a => a.kind).join());
	check('update keeps the manifest folder', again.folder === F);

	// Crash recovery: the files were written but the manifest never saved.
	const recovered = await planFiles({ manifest: null, snapshot: snap1, folder: F, read });
	check('rerun after a crash adopts what is there', recovered.actions.every(a => a.kind === 'adopt'));

	// --- the next snapshot ---
	const v2: FixtureProject = {
		...v1,
		botUpdate: 2,
		updatedAt: '2026-10-01T00:00:00+00:00',
		entities: [
			{ id: 1, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT', description: 'v2 text' }, // re-synthesized
			{ id: 2, name: 'OSCE', type: 'METHOD', sgb: 'METHOD', description: 'now described' }, // changed upstream
			// 3 (Chatbot) merged away upstream
			{ id: 4, name: 'Feedback', type: 'CONCEPT', sgb: 'CONCEPT' }, // new
		],
		articles: [
			{ uid: 'pmc:1', title: 'Kim 2026', mentions: [[1, 'outcome'], [2, null]] },
			{ uid: 'pmc:2', title: 'Lee 2026', mentions: [[4, 'outcome']] },
		],
		relationships: [],
	};
	const snap2 = await readMedLitSnapshot(buildProject(v2));

	const kindOf = (plan: Awaited<ReturnType<typeof planFiles>>, key: string) => plan.actions.find(a => a.key === key)?.kind;

	// The person edited Empathy (changed upstream too) and Kim 2026's page, and deleted OSCE.
	const edited = new Map(vault);
	edited.set(`${F}/entities/Empathy.md`, vault.get(`${F}/entities/Empathy.md`) + '\nMy note.\n');
	edited.delete(`${F}/entities/OSCE.md`);
	const plan = await planFiles({ manifest, snapshot: snap2, folder: F, read: async p => edited.get(p) ?? null });

	const expect: [string, FileActionKind][] = [
		['entity:1', 'conflict'],          // edited here, changed there
		['entity:2', 'locally-deleted'],   // deleted here: not resurrected
		['entity:3', 'trash'],             // gone upstream, untouched here
		['entity:4', 'create'],            // new upstream
		['source:pmc:1', 'overwrite'],     // changed upstream only
		['source:pmc:2', 'create'],
		['file:log.md', 'unchanged'],
	];
	for (const [key, kind] of expect) check(`update: ${key} -> ${kind}`, kindOf(plan, key) === kind, String(kindOf(plan, key)));
	check('update is not older', plan.isUpdate && !plan.older);

	// Edited locally, unchanged upstream.
	const localOnly = new Map(vault);
	localOnly.set(`${F}/log.md`, vault.get(`${F}/log.md`) + '\nmine\n');
	const p2 = await planFiles({ manifest, snapshot: snap1, folder: F, read: async p => localOnly.get(p) ?? null });
	check('edited locally, same upstream: keep-local', kindOf(p2, 'file:log.md') === 'keep-local');

	// Gone upstream but edited locally: kept, no longer tracked.
	const editedGone = new Map(vault);
	editedGone.set(`${F}/entities/Chatbot.md`, 'mine now');
	const p3 = await planFiles({ manifest, snapshot: snap2, folder: F, read: async p => editedGone.get(p) ?? null });
	check('gone upstream, edited here: release', kindOf(p3, 'entity:3') === 'release');

	// Forcing overrides each kind of local decision.
	const forced = await planFiles({
		manifest, snapshot: snap2, folder: F, read: async p => edited.get(p) ?? null,
		force: new Set(['entity:1', 'entity:2']),
	});
	check('force: conflict overwritten', kindOf(forced, 'entity:1') === 'overwrite');
	check('force: deleted page recreated', kindOf(forced, 'entity:2') === 'create');
	check('force keeps the CAS hash of the local text', forced.actions.find(a => a.key === 'entity:1')?.oursHash === hashContent(edited.get(`${F}/entities/Empathy.md`)!));

	// Something else already at the path on a first import.
	const occupied = await planFiles({ manifest: null, snapshot: snap1, folder: F, read: async p => (p.endsWith('OSCE.md') ? 'my own OSCE note' : null) });
	check('first import onto someone else\'s file: occupied', kindOf(occupied, 'entity:2') === 'occupied');

	// A path freed by a trashed page can be taken by a new one in the same run.
	const reuse: FixtureProject = { ...v2, entities: [...v2.entities, { id: 5, name: 'Chatbot', type: 'TECHNOLOGY', sgb: 'TOOL' }] };
	const p4 = await planFiles({ manifest, snapshot: await readMedLitSnapshot(buildProject(reuse)), folder: F, read });
	check('freed path reused: old trashed, new created', kindOf(p4, 'entity:3') === 'trash' && kindOf(p4, 'entity:5') === 'create');

	// The person moved a page; the plan follows it rather than recreating it.
	const moved = { ...manifest, files: { ...files, 'entity:1': { ...files['entity:1'], path: 'Elsewhere/Empathy.md' } } };
	const movedVault = new Map(vault);
	movedVault.set('Elsewhere/Empathy.md', movedVault.get(`${F}/entities/Empathy.md`)!);
	movedVault.delete(`${F}/entities/Empathy.md`);
	const p5 = await planFiles({ manifest: moved, snapshot: snap2, folder: F, read: async p => movedVault.get(p) ?? null });
	const empathy = p5.actions.find(a => a.key === 'entity:1')!;
	check('moved page updated in place', empathy.kind === 'overwrite' && empathy.path === 'Elsewhere/Empathy.md', `${empathy.kind} ${empathy.path}`);
	check('links elsewhere point at the moved page', p5.actions.find(a => a.key === 'file:index.md')!.content!.includes('[[Elsewhere/Empathy|Empathy]]'));

	// An older snapshot after a newer one.
	const newer = { ...manifest, marker: snap2.marker };
	const p6 = await planFiles({ manifest: newer, snapshot: snap1, folder: F, read });
	check('older snapshot flagged', p6.older);

	console.log(fail === 0 ? 'medlit-plan: all checks passed' : `medlit-plan: ${fail} FAILURES`);
	process.exit(fail === 0 ? 0 : 1);
})();
