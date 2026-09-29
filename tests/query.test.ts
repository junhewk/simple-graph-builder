/**
 * The query engine behind Advanced search and the MCP tools.
 *
 * Runs against an in-memory vault. The fixture includes an excluded folder
 * whose content must never surface, directly or through the graph.
 */
import { QueryEngine } from '../src/query/engine';
import { tokenize } from '../src/query/tokenize';
import { TextIndex } from '../src/query/text-index';
import { isQueryVisiblePath } from '../src/query/visibility';
import { ctx, files, graph, links, node, nodes, source, state } from './query-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

(async () => {
	// --- tokenizer ---
	check('Korean particle word -> bigrams', JSON.stringify(tokenize('인공지능은')) === JSON.stringify(['인공', '공지', '지능', '능은']));
	check('NFD tokenizes like NFC', JSON.stringify(tokenize('인공지능'.normalize('NFD'))) === JSON.stringify(tokenize('인공지능')));
	check('GPT-4o -> gpt, 4o', JSON.stringify(tokenize('GPT-4o')) === JSON.stringify(['gpt', '4o']));
	check('single syllable kept', JSON.stringify(tokenize('가')) === JSON.stringify(['가']));
	check('mixed script splits', JSON.stringify(tokenize('gpt모델')) === JSON.stringify(['gpt', '모델']));
	check('stopwords dropped', !tokenize('the transformer of attention').includes('the'));

	// --- index storage: deletes leave tombstones that get compacted ---
	const idx = new TextIndex({ title: 3, body: 1 });
	for (let i = 0; i < 600; i++) idx.set(`n${i}`, { title: `note ${i}`, body: i % 2 ? 'alpha beta' : 'gamma' });
	for (let i = 0; i < 500; i++) idx.delete(`n${i}`);
	check('size tracks live documents', idx.size === 100, String(idx.size));
	const alpha = idx.search(['alpha'], 1000);
	check('search after compaction sees only live docs', alpha.length === 50 && alpha.every(h => Number(h.key.slice(1)) >= 500), String(alpha.length));
	idx.set('n599', { title: 'replaced', body: 'delta' });
	check('replacing a document drops its old terms', idx.search(['alpha'], 1000).length === 49 && idx.search(['delta'], 5)[0]?.key === 'n599');
	check('title outweighs body', (() => {
		const t = new TextIndex({ title: 3, body: 1 });
		t.set('a', { title: 'x', body: 'zebra' });
		t.set('b', { title: 'zebra', body: 'x' });
		return t.search(['zebra'], 2)[0].key === 'b';
	})());

	// --- name matching respects word edges; snippets are plain text ---
	const { calculateMatchScore } = await import('../src/query/match');
	check('"의료 인공지능" does not contain the name "의료인"', calculateMatchScore('의료 인공지능 윤리', '의료인') < 0.5,
		String(calculateMatchScore('의료 인공지능 윤리', '의료인')));
	check('a particle is still allowed', calculateMatchScore('트랜스포머는 무엇인가', '트랜스포머') >= 0.6);
	check('a plural is still allowed', calculateMatchScore('about transformers', 'transformer') >= 0.6);
	check('spacing variants still match', calculateMatchScore('머신 러닝의 역사', '머신러닝') >= 0.6);
	const { plainText } = await import('../src/query/engine');
	check('snippet text drops markdown', plainText('#### Title\n- item **bold** [[Note|alias]] [x](http://y)\\t- z') .replace(/\s+/g, ' ').trim() === 'Title item bold alias x z',
		JSON.stringify(plainText('#### Title\n- item **bold** [[Note|alias]] [x](http://y)\\t- z')));

	// --- visibility ---
	check('config dir hidden', !isQueryVisiblePath(ctx, '.obsidian/plugins/x.md'));
	check('parent traversal rejected', !isQueryVisiblePath({ ...ctx, isMarkdownFile: () => true }, '../outside.md'));
	check('absolute path rejected', !isQueryVisiblePath({ ...ctx, isMarkdownFile: () => true }, '/etc/passwd.md'));
	check('non-markdown rejected', !isQueryVisiblePath({ ...ctx, isMarkdownFile: () => true }, 'AI/image.png'));
	check('excluded folder hidden', !isQueryVisiblePath(ctx, 'Private/secret.md'));
	check('missing file hidden', !isQueryVisiblePath(ctx, 'AI/Nope.md'));
	check('unavailable exclusions fail closed', !isQueryVisiblePath({ ...ctx, userExclusion: () => 'unavailable' }, 'AI/Attention.md'));
	check('entity notes are visible', isQueryVisiblePath(ctx, 'Entities/Transformer.md'));

	const engine = new QueryEngine(graph, source, { yieldFn: async () => undefined, yieldEvery: 2 });
	await engine.ensureIndexed();
	check('index built over visible notes only', engine.indexStatus().total === 6, JSON.stringify(engine.indexStatus()));

	// --- search ---
	const r = await engine.search('transformer');
	const paths = r.notes.map(n => n.path);
	check('title match ranks first', paths[0] === 'AI/Transformer.md', paths.join());
	check('graph-only note found without the word', paths.includes('Notes/Graph-only.md'), paths.join());
	check('graph-only note has no lexical match', r.notes.find(n => n.path === 'Notes/Graph-only.md')?.matchedWords.length === 0);
	check('graph-only note explains itself through the entity',
		r.notes.find(n => n.path === 'Notes/Graph-only.md')?.connections.some(c => c.entity.id === 'concept:transformer') === true);
	check('unrelated note absent', !paths.includes('Notes/Unrelated.md'));
	check('excluded note never returned', !paths.some(p => p.startsWith('Private/')));
	check('config-dir note never returned', !paths.some(p => p.startsWith('.obsidian')));
	check('direct hit outranks graph-only hit',
		paths.indexOf('AI/Transformer.md') < paths.indexOf('Notes/Graph-only.md'));
	check('snippet around the match', /transformer architecture/i.test(r.notes[0].snippet ?? ''), r.notes[0].snippet);
	check('entity found by name', r.entities[0]?.id === 'concept:transformer' && r.entities[0].match === 'name', JSON.stringify(r.entities[0]));
	check('NOTE nodes never appear as entities', r.entities.every(e => e.type !== 'NOTE'));
	check('entity from an excluded note hidden', r.entities.every(e => e.id !== 'project:secret project'));

	const alias = await engine.search('transformer model', { mode: 'entities' });
	check('alias matches', alias.entities[0]?.id === 'concept:transformer', JSON.stringify(alias.entities.map(e => e.id)));

	const ko = await engine.search('인공지능은');
	check('Korean query with a particle finds the note', ko.notes[0]?.path === 'Korean/인공지능.md', JSON.stringify(ko.notes.map(n => n.path)));

	const partial = await engine.search('지능형로봇');
	check('one shared bigram is not a match', !partial.notes.some(n => n.path === 'Korean/인공지능.md' && n.matchedWords.length > 0) &&
		!partial.entities.some(e => e.id === 'concept:인공지능' && e.match === 'description'), JSON.stringify(partial.notes.map(n => n.path)));

	const nfd = await engine.search('인공지능'.normalize('NFD'));
	check('NFD query finds the NFC note', nfd.notes[0]?.path === 'Korean/인공지능.md');

	const prefixed = await engine.search('transformer', { pathPrefix: 'Notes' });
	check('path prefix filters notes', prefixed.notes.length > 0 && prefixed.notes.every(n => n.path.startsWith('Notes/')));

	const typed = await engine.search('secret transformer', { mode: 'entities', types: ['PROJECT'] });
	check('type filter keeps only that type (and nothing hidden)', typed.entities.length === 0, JSON.stringify(typed.entities));

	const seeded = await engine.search('', { seed: 'concept:attention', mode: 'notes' });
	check('seed-only search walks from the node', seeded.notes[0]?.path === 'AI/Attention.md', JSON.stringify(seeded.notes.map(n => n.path)));

	check('empty query returns nothing', (await engine.search('   ')).notes.length === 0);

	// --- entity lookup ---
	const t = engine.getEntity('Transformer');
	check('name resolves to the entity, not the like-named NOTE node', 'id' in t && t.id === 'concept:transformer');
	if ('id' in t) {
		check('relation to a visible entity listed', t.relations.some(x => x.verb === 'uses' && x.other.id === 'concept:attention' && x.detail === 'self-attention'));
		check('relation to a hidden entity omitted', t.relations.every(x => x.other.id !== 'project:secret project'));
		check('evidence note reported', t.relations.find(x => x.verb === 'uses')?.evidence === 'AI/Transformer.md');
		check('entity note reported', t.entityNote === 'Entities/Transformer.md');
		check('source notes are visible ones', t.sourceNotes.length === 2);
	}
	const a = engine.getEntity('Attention');
	check('edge with hidden evidence omitted', 'id' in a && a.relations.every(x => x.verb !== 'inspires'));
	check('alias lookup', 'id' in engine.getEntity('transformer model'));
	const hidden = engine.getEntity('Secret Project');
	check('hidden entity is not found', 'error' in hidden);
	const typo = engine.getEntity('Transfomer');
	check('not-found suggests candidates', 'error' in typo && (typo.candidates as { id: string }[] | undefined)?.[0]?.id === 'concept:transformer', JSON.stringify(typo));

	// --- note lookup ---
	const ambiguous = await engine.getNote('Transformer');
	check('ambiguous title asks for a path', 'error' in ambiguous && (ambiguous.candidates?.length ?? 0) === 2, JSON.stringify(ambiguous));
	const note = await engine.getNote('AI/Transformer');
	check('path without .md resolves', 'path' in note && note.path === 'AI/Transformer.md');
	if ('path' in note) {
		check('backlinks from visible notes', note.backlinks.includes('AI/Attention.md'));
		check('backlinks from hidden notes omitted', !note.backlinks.includes('Private/secret.md'));
		check('entities mentioned', note.entities.some(e => e.id === 'concept:transformer'));
		check('related by shared entity', note.related.some(r => r.path === 'Notes/Graph-only.md' && r.shared.includes('Transformer')));
		check('tags reported', note.tags.includes('ml'));
		check('analyzed flag', note.analyzed === true);
		check('content not included by default', note.content === undefined);
	}
	const withContent = await engine.getNote('[[Attention]]', { includeContent: true, maxChars: 200 });
	check('link-text reference with content', 'content' in withContent && withContent.content?.startsWith('Attention lets') === true);
	check('hidden note refused', 'error' in (await engine.getNote('Private/secret.md')));
	check('config-dir note refused', 'error' in (await engine.getNote('.obsidian/plugins/x.md')));
	check('traversal refused', 'error' in (await engine.getNote('../Private/secret.md')));

	// --- neighbors & paths ---
	const n1 = engine.neighbors('Transformer');
	check('neighbors: visible relation only', 'neighbors' in n1 && n1.neighbors.map(x => x.id).join() === 'concept:attention', JSON.stringify(n1));
	const nOut = engine.neighbors('Attention', { direction: 'out' });
	check('direction filter', 'neighbors' in nOut && nOut.neighbors.length === 0);
	const withNotes = engine.neighbors('Transformer', { includeNotes: true });
	check('neighbors can list mentioning notes', 'notes' in withNotes && withNotes.notes?.length === 2);

	const p1 = engine.findPath('Attention', 'Notes/Graph-only.md');
	check('path from entity to note through the graph', 'found' in p1 && p1.found && p1.path.at(-1)?.id === 'Notes/Graph-only.md', JSON.stringify(p1));
	const p2 = engine.findPath('Attention', 'Transformer');
	check('entity path uses the relation verb', 'found' in p2 && p2.path[1]?.via?.verb === 'uses' && p2.path[1]?.via?.direction === 'in', JSON.stringify(p2));
	const p3 = engine.findPath('Attention', '인공지능');
	check('no path through a hidden-evidence edge', 'found' in p3 && (!p3.found || p3.path.every(s => s.via?.verb !== 'inspires')));

	// --- overview ---
	const o = engine.overview();
	check('overview counts visible entities', o.entities === 3, String(o.entities));
	check('overview counts visible notes', o.notes.total === 6, String(o.notes.total));
	check('overview hides hidden relations', o.relations === 1, String(o.relations));
	check('overview ranks entities', o.topEntities[0]?.id === 'concept:transformer', JSON.stringify(o.topEntities[0]));

	// --- incremental updates ---
	files.set('Notes/New.md', 'A fresh note on transformer training.');
	engine.onNoteChanged('Notes/New.md');
	await engine.settle();
	check('created note is searchable', (await engine.search('training')).notes[0]?.path === 'Notes/New.md');

	files.set('Notes/Renamed.md', files.get('Notes/New.md')!);
	files.delete('Notes/New.md');
	engine.onNoteRenamed('Notes/New.md', 'Notes/Renamed.md');
	await engine.settle();
	const afterRename = (await engine.search('training')).notes.map(n => n.path);
	check('rename moves the note', afterRename.includes('Notes/Renamed.md') && !afterRename.includes('Notes/New.md'), afterRename.join());

	files.delete('Notes/Renamed.md');
	engine.onNoteDeleted('Notes/Renamed.md');
	check('deleted note is gone', (await engine.search('training')).notes.length === 0);

	links['Notes/Unrelated.md'] = { 'AI/Transformer.md': 1 };
	engine.onLinksChanged();
	const relinked = await engine.getNote('AI/Transformer.md');
	check('link changes reach backlinks', 'backlinks' in relinked && relinked.backlinks.includes('Notes/Unrelated.md'));

	state.revision++;
	nodes.push(node('tool:pytorch', 'PyTorch', 'TOOL', ['Notes/Unrelated.md']));
	check('graph revision change is picked up', 'id' in engine.getEntity('PyTorch'));

	console.log(fail ? `\n${fail} FAILURES` : '\nquery: all checks passed');
	process.exit(fail ? 1 : 0);
})();
