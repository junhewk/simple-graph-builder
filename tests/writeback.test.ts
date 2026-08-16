/**
 * Write-back is the first thing this plugin does that edits a user's vault.
 *
 * The failure modes worth guarding are the ones a user would experience as
 * damage: a note rewritten on every save, a file the plugin did not create
 * being overwritten, hand-written text disappearing from an entity note, or two
 * entities fighting over one filename. Each check below corresponds to one of
 * those.
 */
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';
import { upsertEntityNotes, deleteEntityNote, isEntityNotePath, isManagedEntityNote, ID_KEY } from '../src/sync/entity-notes';
import { syncNoteWriteback } from '../src/sync';
import { writeRelatedProperty, clearRelatedProperty, computeRelatedLinks } from '../src/sync/related';
import { WriteGuard } from '../src/sync/write-guard';
import { MANAGED_START, MANAGED_END } from '../src/sync/render';
import { OntologyNode, OntologyEdge } from '../src/types';
import { DEFAULT_SETTINGS } from '../src/settings';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const ml = (): OntologyNode => ({
	id: 'concept:machine learning',
	entityType: 'CONCEPT',
	properties: { name: 'Machine Learning', description: 'Learns patterns from data.', aliases: ['ML', '머신러닝'] },
	sourceNotes: ['notes/ai.md'],
});
const hinton = (): OntologyNode => ({
	id: 'person:geoffrey hinton',
	entityType: 'PERSON',
	properties: { name: 'Geoffrey Hinton' },
	sourceNotes: ['notes/ai.md'],
});
const edge = (): OntologyEdge => ({
	id: 'person:geoffrey hinton->concept:machine learning:develops',
	source: 'person:geoffrey hinton',
	target: 'concept:machine learning',
	relationship: 'develops',
	properties: {},
	sourceNote: 'notes/ai.md',
});

async function seeded(settings = {}) {
	const ctx = fakeSyncPlugin(settings);
	await ctx.graphCache.ensureLoaded();
	ctx.graphCache.addNode(ml());
	ctx.graphCache.addNode(hinton());
	ctx.graphCache.addEdge(edge());
	ctx.vault.seed('notes/ai.md', '# AI\n\nHinton works on machine learning.\n');
	return ctx;
}

async function main() {
	// --- entity notes ------------------------------------------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());

		check('an entity note is created per entity', vault.files.size === 3, `${vault.files.size} files`);
		check('notes land in the configured folder', vault.files.has('Entities/Machine Learning.md'),
			[...vault.files.keys()].join(', '));

		const fm = vault.frontmatter.get('Entities/Machine Learning.md') ?? {};
		check('the node id is recorded', fm[ID_KEY] === 'concept:machine learning');
		check('the entity type is recorded', fm['entity-type'] === 'CONCEPT');
		check('resolution aliases become Obsidian aliases',
			JSON.stringify(fm['aliases']) === JSON.stringify(['ML', '머신러닝']), JSON.stringify(fm['aliases']));
		check('an entity with no aliases gets no alias key',
			!('aliases' in (vault.frontmatter.get('Entities/Geoffrey Hinton.md') ?? {})));

		const body = vault.body('Entities/Machine Learning.md');
		check('the description is written', body.includes('Learns patterns from data.'));
		const hintonBody = vault.body('Entities/Geoffrey Hinton.md');
		check('relationships become links', hintonBody.includes('- develops [[Entities/Machine Learning]]'), hintonBody);

		// Both regions are written in one pass, so one must not eat the other.
		check('frontmatter survives the body write',
			(vault.bodies.get('Entities/Machine Learning.md') ?? '').startsWith('---\n'),
			JSON.stringify((vault.bodies.get('Entities/Machine Learning.md') ?? '').slice(0, 40)));
		check('and the metadata cache still reports it',
			(vault.frontmatter.get('Entities/Machine Learning.md') ?? {})[ID_KEY] === 'concept:machine learning');
	}

	// --- a read that lags behind the write must not destroy anything --------
	{
		const { plugin, vault, graphCache } = await seeded();
		vault.serveStale = true;

		await upsertEntityNotes(plugin, graphCache.getAllNodes());

		const content = vault.bodies.get('Entities/Machine Learning.md') ?? '';
		check('frontmatter survives even when the read is stale', content.startsWith('---\n'),
			JSON.stringify(content.slice(0, 60)));
		check('the aliases are still there', content.includes('머신러닝'), JSON.stringify(content.slice(0, 120)));
		check('and the managed block was still written', content.includes('Learns patterns from data.'));
		check('the entity note path is remembered on the node',
			graphCache.getNodeById('concept:machine learning')?.properties.entityNotePath === 'Entities/Machine Learning.md');

		// The property that keeps the vault quiet.
		const before = { ...vault.stats };
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		check('re-running writes nothing at all',
			vault.stats.creates === before.creates &&
			vault.stats.bodyWrites === before.bodyWrites &&
			vault.stats.frontmatterWrites === before.frontmatterWrites,
			`${vault.stats.bodyWrites - before.bodyWrites} body, ${vault.stats.frontmatterWrites - before.frontmatterWrites} frontmatter`);
	}

	// --- never take over a file the plugin does not own --------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		vault.seed('Entities/Machine Learning.md', '# My own note about ML\n');

		await upsertEntityNotes(plugin, [graphCache.getNodeById('concept:machine learning')!]);

		check('a user file is left untouched', vault.bodies.get('Entities/Machine Learning.md') === '# My own note about ML\n');
		check('the entity goes to its next candidate name',
			vault.files.has('Entities/Machine Learning (CONCEPT).md'), [...vault.files.keys()].join(', '));
	}

	// --- two entities, one name -------------------------------------------
	{
		const { plugin, graphCache, vault } = await seeded();
		graphCache.addNode({
			id: 'organization:machine learning',
			entityType: 'ORGANIZATION',
			properties: { name: 'Machine Learning' },
			sourceNotes: ['notes/ai.md'],
		});

		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		check('a same-named entity of another type gets its own file',
			vault.files.has('Entities/Machine Learning.md') && vault.files.has('Entities/Machine Learning (ORGANIZATION).md'),
			[...vault.files.keys()].join(', '));
		check('paths stay stable on a second run', await (async () => {
			const paths = [...vault.files.keys()].sort().join('|');
			await upsertEntityNotes(plugin, graphCache.getAllNodes());
			return [...vault.files.keys()].sort().join('|') === paths;
		})());
	}

	// --- a user's own text in an entity note survives ----------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());

		const path = 'Entities/Machine Learning.md';
		vault.bodies.set(path, `${vault.bodies.get(path)}\n## My reading list\n\n- a paper\n`);

		// Something changed upstream, so the managed block is rewritten.
		const node = graphCache.getNodeById('concept:machine learning')!;
		node.properties.description = 'A different description.';
		graphCache.updateNode(node);
		await upsertEntityNotes(plugin, [node]);

		const body = vault.bodies.get(path) ?? '';
		check('hand-written sections survive regeneration', body.includes('## My reading list') && body.includes('- a paper'));
		check('the managed block is updated', body.includes('A different description.') && !body.includes('Learns patterns from data.'));
		check('exactly one managed block remains', body.split(MANAGED_START).length === 2 && body.split(MANAGED_END).length === 2);
	}

	// --- the related property ---------------------------------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		const note = vault.files.get('notes/ai.md')!;

		check('links are computed for the note',
			computeRelatedLinks(plugin, 'notes/ai.md').length === 2, JSON.stringify(computeRelatedLinks(plugin, 'notes/ai.md')));

		check('the first write reports a change', await writeRelatedProperty(plugin, note) === true);
		const links = (vault.frontmatter.get('notes/ai.md') ?? {})['related'] as string[];
		check('the property holds wikilinks to entity notes',
			links.includes('[[Entities/Machine Learning]]') && links.includes('[[Entities/Geoffrey Hinton]]'), JSON.stringify(links));
		check('links are sorted', JSON.stringify(links) === JSON.stringify([...links].sort()));

		check('writing again changes nothing', await writeRelatedProperty(plugin, note) === false);
		check('the prose was never touched',
			vault.body('notes/ai.md') === '# AI\n\nHinton works on machine learning.\n',
			JSON.stringify(vault.body('notes/ai.md')));
		check('the property really is in the file text',
			(vault.bodies.get('notes/ai.md') ?? '').includes('related:'));

		// An entity leaves the note: the property follows.
		graphCache.removeNode('person:geoffrey hinton');
		check('a removed entity updates the property', await writeRelatedProperty(plugin, note) === true);
		check('only the remaining entity is listed',
			((vault.frontmatter.get('notes/ai.md') ?? {})['related'] as string[]).length === 1);

		graphCache.removeNode('concept:machine learning');
		await writeRelatedProperty(plugin, note);
		check('an empty list removes the property', !('related' in (vault.frontmatter.get('notes/ai.md') ?? {})));
	}

	// --- opt-in, and the custom property name ------------------------------
	{
		const { plugin, vault, graphCache } = await seeded({ enableRelatedWriteback: false });
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		const note = vault.files.get('notes/ai.md')!;
		check('the property is not written when turned off', await writeRelatedProperty(plugin, note) === false);
		check('no frontmatter was added', !vault.frontmatter.has('notes/ai.md'));

		const custom = await seeded({ relatedPropertyName: 'entities' });
		await upsertEntityNotes(custom.plugin, custom.graphCache.getAllNodes());
		await writeRelatedProperty(custom.plugin, custom.vault.files.get('notes/ai.md')!);
		check('a custom property name is honoured', 'entities' in (custom.vault.frontmatter.get('notes/ai.md') ?? {}));
		check('clearing removes the custom key', await (async () => {
			await clearRelatedProperty(custom.plugin, custom.vault.files.get('notes/ai.md')!);
			return !('entities' in (custom.vault.frontmatter.get('notes/ai.md') ?? {}));
		})());
	}

	// --- removing links must not touch a property the user wrote -----------
	{
		// `related` is the default name and a very common hand-authored Dataview
		// property. Removing "the plugin's links" must mean exactly that.
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		const note = vault.files.get('notes/ai.md')!;

		vault.frontmatter.set('notes/ai.md', { related: ['[[My Reading List]]', '[[Some Project]]'] });
		check('a purely hand-written property is left alone',
			await clearRelatedProperty(plugin, note) === false);
		check('and its entries are all still there',
			((vault.frontmatter.get('notes/ai.md') ?? {})['related'] as string[]).length === 2);

		// Mixed: the plugin's own links go, the user's stay.
		vault.frontmatter.set('notes/ai.md', {
			related: ['[[My Reading List]]', '[[Entities/Machine Learning]]', '[[Entities/Geoffrey Hinton|Geoffrey Hinton]]'],
		});
		check('a mixed property is cleaned selectively', await clearRelatedProperty(plugin, note) === true);
		const left = (vault.frontmatter.get('notes/ai.md') ?? {})['related'] as string[];
		check('only the user entry survives', JSON.stringify(left) === JSON.stringify(['[[My Reading List]]']), JSON.stringify(left));

		// Once nothing of the user's is left, the key itself goes.
		vault.frontmatter.set('notes/ai.md', { related: ['[[Entities/Machine Learning]]'] });
		await clearRelatedProperty(plugin, note);
		check('an all-plugin property is removed entirely',
			!('related' in (vault.frontmatter.get('notes/ai.md') ?? {})));
	}

	// --- a file the plugin made is never analyzed, whatever the settings ----
	{
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		const entityNote = vault.files.get('Entities/Machine Learning.md')!;

		check('an entity note is recognized by its marker', isManagedEntityNote(plugin, entityNote));
		check('a normal note is not', !isManagedEntityNote(plugin, vault.files.get('notes/ai.md')!));

		// Turning the feature off leaves the files on disk; the path rule stops
		// applying, so the marker is what keeps them out of the extractor.
		plugin.settings.enableEntityNotes = false;
		check('the path rule goes quiet when the feature is off',
			!isEntityNotePath(plugin.settings, entityNote.path));
		check('but the marker still identifies it', isManagedEntityNote(plugin, entityNote));
	}

	// --- Korean identity ---------------------------------------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		const nfc = '머신러닝';
		graphCache.addNode({
			id: 'concept:기계학습',
			entityType: 'CONCEPT',
			properties: { name: nfc.normalize('NFD'), aliases: ['기계학습'] },
			sourceNotes: ['notes/ai.md'],
		});

		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		check('a decomposed Korean name becomes one composed filename',
			vault.files.has(`Entities/${nfc}.md`), [...vault.files.keys()].join(', '));

		// The same entity written twice must not produce a second file.
		const count = vault.files.size;
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		check('no duplicate file for the other normal form', vault.files.size === count, `${vault.files.size} vs ${count}`);
	}

	// --- syncing one note keeps the entities it touched consistent ----------
	{
		const { plugin, vault, graphCache } = await seeded();

		// An entity belonging to another note, which this note's analysis gave a
		// new outgoing relationship. Its own note lists outgoing relationships, so
		// it has to be rewritten even though it is not this note's entity.
		graphCache.addNode({
			id: 'organization:university of toronto',
			entityType: 'ORGANIZATION',
			properties: { name: 'University of Toronto' },
			sourceNotes: ['notes/other.md'],
		});
		graphCache.addEdge({
			id: 'organization:university of toronto->person:geoffrey hinton:employs',
			source: 'organization:university of toronto',
			target: 'person:geoffrey hinton',
			relationship: 'employs',
			properties: {},
			sourceNote: 'notes/ai.md',
		});

		await syncNoteWriteback(plugin, vault.files.get('notes/ai.md')!);

		check('an entity from another note still gets its note written',
			vault.files.has('Entities/University of Toronto.md'), [...vault.files.keys()].join(', '));
		check('and it lists the relationship this note created',
			vault.body('Entities/University of Toronto.md').includes('- employs [[Entities/Geoffrey Hinton]]'),
			vault.body('Entities/University of Toronto.md'));
		check('the analyzed note still gets its own property',
			'related' in (vault.frontmatter.get('notes/ai.md') ?? {}));
	}

	// --- deletion ----------------------------------------------------------
	{
		const { plugin, vault, graphCache } = await seeded();
		await upsertEntityNotes(plugin, graphCache.getAllNodes());
		const node = graphCache.getNodeById('concept:machine learning')!;

		check('an entity note can be trashed', await deleteEntityNote(plugin, node) === true);
		check('it went to the trash, not to nowhere', vault.stats.trashed.includes('Entities/Machine Learning.md'));

		// A file at the remembered path that is not ours must never be trashed.
		const stray = graphCache.getNodeById('person:geoffrey hinton')!;
		vault.frontmatter.set('Entities/Geoffrey Hinton.md', { note: 'user rewrote this' });
		check('a file without our id is never deleted', await deleteEntityNote(plugin, stray) === false);
		check('it is still there', vault.files.has('Entities/Geoffrey Hinton.md'));
	}

	// --- keeping the plugin out of its own way -----------------------------
	{
		const settings = { ...DEFAULT_SETTINGS, enableEntityNotes: true, entityFolder: 'Entities' };
		check('entity notes are recognized by path', isEntityNotePath(settings, 'Entities/Machine Learning.md'));
		check('user notes are not', !isEntityNotePath(settings, 'notes/ai.md'));
		check('a similarly named folder is not swept in', !isEntityNotePath(settings, 'Entities Archive/x.md'));
		check('nothing is excluded while the feature is off',
			!isEntityNotePath({ ...settings, enableEntityNotes: false }, 'Entities/x.md'));

		const guard = new WriteGuard();
		let seenDuringWrite = false;
		await guard.guard('notes/ai.md', async () => { seenDuringWrite = guard.isOwnWrite('notes/ai.md'); });
		check('a write is claimed while it runs', seenDuringWrite);
		check('and stays claimed just after, when modify fires', guard.isOwnWrite('notes/ai.md'));
		check('an untouched path is never claimed', !guard.isOwnWrite('notes/other.md'));
		check('a decomposed path matches its composed claim',
			guard.isOwnWrite('notes/ai.md'.normalize('NFD')));
	}

	console.log(fail === 0 ? 'writeback: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
