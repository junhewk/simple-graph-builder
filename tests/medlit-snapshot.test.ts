/**
 * Reading med-lit projects: the graph export, the pages, and what is refused.
 *
 * The refusals matter as much as the reads. A project without an export, an
 * export in a newer format or for another project, an unknown ontology: each
 * must stop the import before anything is written, with a message the person
 * can act on.
 */
import { readMedLitSnapshot, parseJsonFrontmatter, compareMarkers } from '../src/import/snapshot';
import { ImportError } from '../src/import/errors';
import { buildProject, FixtureProject, MemoryReader } from './medlit-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const base: FixtureProject = {
	botUpdate: 3,
	entities: [
		{ id: 1, name: 'Large language models', type: 'TECHNOLOGY', sgb: 'TOOL', description: 'LLMs.', aliases: [['LLMs', 'acronym']] },
		{ id: 2, name: 'Empathy', type: 'CONCEPT', sgb: 'CONCEPT' },
		{ id: 3, name: 'OSCE', type: 'METHOD', sgb: 'METHOD' },
	],
	articles: [
		{ uid: 'pmc:PMC1', title: 'Kim 2026 - Chatbots', mentions: [[1, 'intervention'], [2, 'outcome']] },
		{ uid: 'pubmed:2', title: 'Lee 2026 - OSCE', mentions: [[1, null], [3, 'context']] },
	],
	relationships: [
		{ id: 1, source: 1, target: 2, verb: 'may erode', evidence: [['pmc:PMC1', 'LLMs may erode empathy.']] },
		{ id: 2, source: 1, target: 3, verb: 'evaluated in', evidence: [['pubmed:2', 'q1'], ['pmc:PMC1', 'q2']] },
	],
};

async function expectError(name: string, reader: MemoryReader, pattern: RegExp) {
	try {
		await readMedLitSnapshot(reader);
		check(name, false, 'no error');
	} catch (e) {
		check(name, e instanceof ImportError && pattern.test(e.message), String(e));
	}
}

(async () => {
	const snap = await readMedLitSnapshot(buildProject(base));
	check('project id read', snap.project.id === 'proj1');
	check('entities read', snap.kg.entities.length === 3);
	check('entities typed by the export', snap.kg.entities.find(e => e.id === 1)?.sgbType === 'TOOL');
	check('med-lit type kept', snap.kg.entities.find(e => e.id === 1)?.medLitType === 'TECHNOLOGY');
	check('aliases read', snap.kg.entities.find(e => e.id === 1)!.aliases.some(a => a.alias === 'LLMs' && a.source === 'acronym'));
	check('mentions read', snap.kg.mentions.length === 4);
	check('mention roles kept', snap.kg.mentions.some(m => m.role === 'outcome') && snap.kg.mentions.some(m => m.role === null));
	check('relationship evidence grouped', snap.kg.relationships.find(r => r.id === 2)?.evidence.length === 2);
	check('file keys: sources', snap.files.some(f => f.key === 'source:pmc:PMC1'));
	check('file keys: entities', snap.files.some(f => f.key === 'entity:2' && f.rel === 'entities/Empathy.md'));
	check('file keys: others by path', snap.files.some(f => f.key === 'file:index.md'));
	check('marker from export', snap.marker.lastUpdate === 3 && snap.marker.articleCount === 2);
	check('no warnings for a clean project', snap.warnings.length === 0, snap.warnings.join('; '));

	const noExport = buildProject(base).delete('.med-lit/sgb-export.json');
	await expectError('project without an export refused', noExport, /export_wiki/);
	await expectError('newer export format refused', buildProject({ ...base, format: 'med-lit-sgb/2' }), /newer/);
	await expectError('export of another project refused', buildProject({ ...base, exportProjectId: 'other' }), /different med-lit project/);
	await expectError('other ontology refused', buildProject({ ...base, ontology: 'med-lit/2' }), /ontology/);
	await expectError('not a project', new MemoryReader(), /not a med-lit project/);
	check('minor format accepted', (await readMedLitSnapshot(buildProject({ ...base, format: 'med-lit-sgb/1.1' }))).kg.entities.length === 3);

	// sgb_type is med-lit's call; an unusable one falls back to the most
	// neutral type, and says so.
	const odd = await readMedLitSnapshot(buildProject({ ...base, entities: [...base.entities.slice(0, 2), { id: 3, name: 'OSCE', type: 'METHOD', sgb: 'NOTE' }] }));
	check('invalid sgb_type falls back to CONCEPT', odd.kg.entities.find(e => e.id === 3)?.sgbType === 'CONCEPT');
	check('invalid sgb_type is reported', odd.warnings.some(w => /sgb_type/.test(w)));

	// A page without the generator line was taken over in med-lit; leave it out.
	const withNotes = await readMedLitSnapshot(buildProject(base).set('notes.md', '# my own notes\n'));
	check('non-generated page skipped', !withNotes.files.some(f => f.rel === 'notes.md'));

	// A page for an entity the export no longer has is a leftover, not content.
	const leftover = buildProject(base).set('entities/Gone.md', '---\ngenerator: med-lit-mcp\ntype: "entity"\nentity_id: 99\n---\n# Gone\n');
	const withLeftover = await readMedLitSnapshot(leftover);
	check('leftover entity page skipped', !withLeftover.files.some(f => f.key === 'entity:99'));
	check('leftover reported', withLeftover.warnings.some(w => /leftover/.test(w)));

	// A run that died before finishing: the export is the last good state.
	const crashed = await readMedLitSnapshot(buildProject({
		...base,
		bot: { active: null, history: [{ update: 3, outcome: 'finished' }, { update: 4, outcome: 'stopped before bot_finish; reported by the next run' }] },
	}));
	check('unfinished run reported', crashed.warnings.some(w => /update 4\) did not finish/.test(w) && /update 3/.test(w)), crashed.warnings.join('; '));
	const running = await readMedLitSnapshot(buildProject({ ...base, bot: { active: { update: 4 }, history: [] } }));
	check('run in progress reported', running.warnings.some(w => /in progress/.test(w)));

	const parsed = parseJsonFrontmatter('---\ngenerator: med-lit-bot\ndate: 2026-10-01\nsources: 7\naliases: ["A", "B"]\n---\nbody');
	check('frontmatter JSON values', parsed?.sources === 7 && Array.isArray(parsed?.aliases));
	check('frontmatter plain scalars', parsed?.date === '2026-10-01');

	const older = { lastUpdate: 4, dataUpdatedAt: '2026-09-30T10:00:00+00:00', articleCount: 10 };
	const newer = { lastUpdate: 6, dataUpdatedAt: '2026-09-30T23:00:00+00:00', articleCount: 15 };
	check('marker: older < newer', compareMarkers(older, newer) < 0 && compareMarkers(newer, older) > 0);
	check('marker: same = same', compareMarkers(newer, { ...newer }) === 0);

	console.log(fail === 0 ? 'medlit-snapshot: all checks passed' : `medlit-snapshot: ${fail} FAILURES`);
	process.exit(fail === 0 ? 0 : 1);
})();
