/**
 * The string layer of vault write-back.
 *
 * These functions decide what the plugin writes into a user's notes, so the
 * properties that matter are: never lose user text, never grow a file on
 * repeat, and never emit a filename or link the vault will reject. Korean is
 * exercised throughout because NFD input is the normal case on macOS.
 */
import { stripFrontmatter } from '../src/sync/note-content';
import { sanitizeFileName, fileNameCandidates, entityNotePath, normalizeFolder } from '../src/sync/filenames';
import { renderEntityLink, renderManagedBlock, replaceManagedBlock, MANAGED_START, MANAGED_END } from '../src/sync/render';
import { OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const node = (over: Partial<OntologyNode> = {}): OntologyNode => ({
	id: 'concept:machine learning',
	entityType: 'CONCEPT',
	properties: { name: 'Machine Learning' },
	sourceNotes: ['a.md'],
	...over,
});

// --- stripFrontmatter ---------------------------------------------------
{
	const none = stripFrontmatter('# Title\n\nbody');
	check('no frontmatter leaves content whole', none.yaml === null && none.body === '# Title\n\nbody' && none.bodyStart === 0);

	const fm = stripFrontmatter('---\ntags: [ai]\n---\n# Title\n');
	check('frontmatter is split off', fm.yaml === 'tags: [ai]\n' && fm.body === '# Title\n', JSON.stringify(fm));

	const empty = stripFrontmatter('---\n---\nbody');
	check('empty frontmatter parses', empty.yaml === '' && empty.body === 'body', JSON.stringify(empty));

	const crlf = stripFrontmatter('---\r\ntags: [ai]\r\n---\r\nbody');
	check('CRLF frontmatter parses', crlf.body === 'body', JSON.stringify(crlf));

	const bom = stripFrontmatter('﻿---\ntags: [ai]\n---\nbody');
	check('BOM before frontmatter parses', bom.body === 'body', JSON.stringify(bom));

	const rule = stripFrontmatter('# Title\n\n---\n\nnot frontmatter');
	check('a horizontal rule mid-note is not frontmatter', rule.yaml === null);

	const unclosed = stripFrontmatter('---\ntags: [ai]\nno close');
	check('unclosed frontmatter is treated as body', unclosed.yaml === null && unclosed.bodyStart === 0);

	// The reason this module exists: editing frontmatter must not change the body.
	const before = stripFrontmatter('---\ntags: [a]\n---\nsame body\n').body;
	const after = stripFrontmatter('---\ntags: [a]\nrelated:\n  - "[[X]]"\n---\nsame body\n').body;
	check('adding a property leaves the body identical', before === after);
}

// --- sanitizeFileName ---------------------------------------------------
{
	check('path separators are removed', !/[\\/:]/.test(sanitizeFileName('AI/ML: Deep\\Learning')), sanitizeFileName('AI/ML: Deep\\Learning'));
	check('link-breaking chars are removed', sanitizeFileName('Foo [[bar]] #tag|pipe^caret') === 'Foo bar tag pipe caret', sanitizeFileName('Foo [[bar]] #tag|pipe^caret'));
	check('newlines collapse to one space', sanitizeFileName('multi\n\nline\tname') === 'multi line name', sanitizeFileName('multi\n\nline\tname'));
	check('empty name falls back', sanitizeFileName('///') === 'entity', sanitizeFileName('///'));
	check('whitespace-only name falls back', sanitizeFileName('   ') === 'entity');
	check('leading dots are stripped', sanitizeFileName('...hidden') === 'hidden', sanitizeFileName('...hidden'));
	check('trailing dot is stripped', sanitizeFileName('name.') === 'name');
	check('windows reserved name is escaped', sanitizeFileName('CON') === 'CON entity', sanitizeFileName('CON'));
	check('long names are capped', sanitizeFileName('x'.repeat(400)).length <= 100);
	check('no trailing space after the cap', !/\s$/.test(sanitizeFileName('word '.repeat(80))));

	// Korean: NFD in, NFC out, so two spellings of one name give one filename.
	const nfc = '머신러닝';
	const nfd = nfc.normalize('NFD');
	check('NFD Korean sanitizes to NFC', sanitizeFileName(nfd) === nfc, `${sanitizeFileName(nfd).length} vs ${nfc.length}`);
	check('Korean survives sanitizing intact', sanitizeFileName(nfc) === nfc);
}

// --- candidates and paths -----------------------------------------------
{
	const c = fileNameCandidates(node());
	check('first candidate is the plain name', c[0] === 'Machine Learning', c[0]);
	check('second candidate disambiguates by type', c[1] === 'Machine Learning (CONCEPT)', c[1]);
	check('third candidate is hash-suffixed', /^Machine Learning \([0-9a-f]{1,6}\)$/.test(c[2]), c[2]);
	check('candidates are distinct', new Set(c).size === 3);

	const other = fileNameCandidates(node({ id: 'concept:other', properties: { name: 'Machine Learning' } }));
	check('hash candidate differs per node id', other[2] !== c[2], `${other[2]} vs ${c[2]}`);
	check('hash candidate is stable', fileNameCandidates(node())[2] === c[2]);

	check('path joins folder and name', entityNotePath('Entities', 'Machine Learning') === 'Entities/Machine Learning.md');
	check('surrounding slashes are ignored', entityNotePath('/Entities/', 'X') === 'Entities/X.md');
	check('nested folders work', entityNotePath('KG/Entities', 'X') === 'KG/Entities/X.md');
	check('blank folder means vault root', entityNotePath('', 'X') === 'X.md');
	check('normalizeFolder strips slashes', normalizeFolder('/a/b/') === 'a/b');
}

// --- links ---------------------------------------------------------------
{
	check('link drops the extension', renderEntityLink('Entities/Machine Learning.md', 'Machine Learning') === '[[Entities/Machine Learning]]',
		renderEntityLink('Entities/Machine Learning.md', 'Machine Learning'));
	check('sanitized filename keeps the real name as alias',
		renderEntityLink('Entities/AI ML.md', 'AI/ML') === '[[Entities/AI ML|AI/ML]]',
		renderEntityLink('Entities/AI ML.md', 'AI/ML'));
	check('brackets in a display name cannot break the link',
		!/\[\[.*\[\[/.test(renderEntityLink('Entities/X.md', 'a [[b]] c')),
		renderEntityLink('Entities/X.md', 'a [[b]] c'));
	check('a pipe in a display name cannot split the link',
		renderEntityLink('Entities/X.md', 'a|b').split('|').length === 2,
		renderEntityLink('Entities/X.md', 'a|b'));
}

// --- managed block -------------------------------------------------------
{
	const rels = [
		{ relationship: 'uses', targetName: 'Backpropagation', targetPath: 'Entities/Backpropagation.md' },
		{ relationship: 'studied by', targetName: 'Geoffrey Hinton', targetPath: 'Entities/Geoffrey Hinton.md' },
	];
	const managed = renderManagedBlock(node({ properties: { name: 'Machine Learning', description: 'Learns from data.' } }), rels, true);
	check('block carries the description', managed.includes('Learns from data.'));
	check('block lists relationships as links', managed.includes('- uses [[Entities/Backpropagation]]'), managed);
	check('block has no trailing blank line', !/\n$/.test(managed));

	const noRels = renderManagedBlock(node({ properties: { name: 'X', description: 'd' } }), rels, false);
	check('relationships can be turned off', !noRels.includes('## Relationships'));

	const bare = renderManagedBlock(node({ properties: { name: 'X' } }), [], true);
	check('an entity with nothing to say renders empty', bare === '', JSON.stringify(bare));

	// Insertion into a file that has none.
	const inserted = replaceManagedBlock('# Machine Learning\n\nMy own notes.\n', managed);
	check('user content is kept above the block', inserted.startsWith('# Machine Learning\n\nMy own notes.'));
	check('block markers are present', inserted.includes(MANAGED_START) && inserted.includes(MANAGED_END));

	// Replacement, and the property that matters most: repeat writes are no-ops.
	const again = replaceManagedBlock(inserted, managed);
	check('re-applying the same block changes nothing', again === inserted);

	const updated = replaceManagedBlock(inserted, 'new managed text');
	check('managed text is replaced', updated.includes('new managed text') && !updated.includes('Learns from data.'));
	check('user text survives replacement', updated.includes('My own notes.'));

	// User text below the block must survive too.
	const withTail = `${inserted}\n## My section\n\nhand written\n`;
	const tailReplaced = replaceManagedBlock(withTail, 'fresh');
	check('user text below the block survives', tailReplaced.includes('## My section') && tailReplaced.includes('hand written'));
	check('replacement stays idempotent with a tail', replaceManagedBlock(tailReplaced, 'fresh') === tailReplaced);

	// Damaged markers must not accumulate blocks -- and must not eat text. The
	// markers are invisible comments in reading view, so deleting the block and
	// clipping one marker is an ordinary editing accident.
	const damaged = inserted.replace(MANAGED_END, '');
	const repaired = replaceManagedBlock(damaged, managed);
	check('a lost end marker is repaired, not duplicated',
		repaired.split(MANAGED_START).length === 2, `${repaired.split(MANAGED_START).length - 1} start markers`);
	check('repair is idempotent', replaceManagedBlock(repaired, managed) === repaired);

	const clipped = `# Title\n\n${MANAGED_START}\nold managed text\n\n## My own research\n\n- a long hand-written section\n`;
	const rescued = replaceManagedBlock(clipped, 'fresh');
	check('text below a clipped start marker is not swallowed',
		rescued.includes('## My own research') && rescued.includes('- a long hand-written section'), rescued);
	check('the clipped marker itself is removed',
		rescued.split(MANAGED_START).length === 2, rescued);
	check('and the rescue is idempotent', replaceManagedBlock(rescued, 'fresh') === rescued);

	const orphanEnd = `notes\n\n${MANAGED_END}\n`;
	const fixedOrphan = replaceManagedBlock(orphanEnd, managed);
	check('a stray end marker is absorbed',
		fixedOrphan.split(MANAGED_END).length === 2, fixedOrphan);

	const emptyFile = replaceManagedBlock('', managed);
	check('an empty file gets just the block', emptyFile.startsWith(MANAGED_START));
}

console.log(fail === 0 ? 'sync-pure: all checks passed' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
