/**
 * Change detection has to survive the plugin editing notes.
 *
 * Write-back puts a `related:` property in a note's frontmatter. If the stored
 * hash covered the whole file, that write would make the note look changed, and
 * the next save would re-analyze it -- a paid API call per note, on a loop the
 * user never asked for. Hashing only the body makes the plugin's own edits
 * invisible to change detection by construction.
 *
 * The second requirement is the upgrade: notes analyzed by an earlier version
 * carry a full-content hash, and those must still count as analyzed.
 */
import { computeHash, computeNoteHashes, hasNoteChangedByHashes, upgradeLegacyHash, updateNoteHash } from '../src/graph/hashes';
import { HashData } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const BODY = '# Machine Learning\n\nHinton studies backpropagation.\n';
const plain = `---\ntags: [ai]\n---\n${BODY}`;
const written = `---\ntags: [ai]\nrelated:\n  - "[[Entities/Machine Learning]]"\n  - "[[Entities/Geoffrey Hinton]]"\n---\n${BODY}`;

const store = (path: string, hash: string): HashData => updateNoteHash({ hashes: [] }, path, hash);

// --- the loop this prevents ---------------------------------------------
{
	const before = computeNoteHashes(plain);
	const hashes = store('a.md', before.body);

	check('a note is unchanged right after analysis', !hasNoteChangedByHashes(hashes, 'a.md', before));
	check('writing the related property does not count as a change',
		!hasNoteChangedByHashes(hashes, 'a.md', computeNoteHashes(written)));
	check('the body hash is what gets stored', hashes.hashes[0].hash === before.body);
	check('body hash ignores frontmatter entirely',
		computeNoteHashes(plain).body === computeNoteHashes(written).body);
	check('body hash equals a plain hash of the body', before.body === computeHash(BODY));
}

// --- real edits must still register --------------------------------------
{
	const hashes = store('a.md', computeNoteHashes(plain).body);
	const edited = computeNoteHashes(`${plain}\nA new sentence.\n`);
	check('editing the body registers as a change', hasNoteChangedByHashes(hashes, 'a.md', edited));
	check('an unseen note registers as changed', hasNoteChangedByHashes(hashes, 'b.md', computeNoteHashes(plain)));
}

// --- upgrading from whole-file hashes ------------------------------------
{
	// What an earlier version stored: a hash of the entire file.
	const legacyHashes = store('a.md', computeHash(plain));
	check('a note analyzed by the old version is not re-analyzed',
		!hasNoteChangedByHashes(legacyHashes, 'a.md', computeNoteHashes(plain)));
	check('an old hash plus a real body edit still registers',
		hasNoteChangedByHashes(legacyHashes, 'a.md', computeNoteHashes(`${plain}\nmore text\n`)));

	// The legacy record has to be converted the moment it is recognized. If it
	// survives, the first frontmatter edit -- write-back itself, or the user
	// adding a tag -- makes the note look changed, and enabling write-back would
	// re-analyze, and re-bill, the whole vault.
	check('recognizing a legacy hash upgrades the record',
		upgradeLegacyHash(legacyHashes, 'a.md', computeNoteHashes(plain)) === true);
	check('the stored hash is now the body hash',
		legacyHashes.hashes[0].hash === computeNoteHashes(plain).body);
	check('so writing the property no longer counts as a change',
		!hasNoteChangedByHashes(legacyHashes, 'a.md', computeNoteHashes(written)));
	check('upgrading is idempotent',
		upgradeLegacyHash(legacyHashes, 'a.md', computeNoteHashes(plain)) === false);
	check('a body edit still registers after the upgrade',
		hasNoteChangedByHashes(legacyHashes, 'a.md', computeNoteHashes(`${plain}\nnew text\n`)));

	// Without the upgrade this was the failure: legacy hash + plugin write.
	const notUpgraded = store('b.md', computeHash(plain));
	check('an un-upgraded legacy record is what caused the re-analysis',
		hasNoteChangedByHashes(notUpgraded, 'b.md', computeNoteHashes(written)));
	check('and nothing to upgrade means no write',
		upgradeLegacyHash(store('c.md', computeNoteHashes(plain).body), 'c.md', computeNoteHashes(plain)) === false);
}

// --- notes without frontmatter -------------------------------------------
{
	const bare = computeNoteHashes(BODY);
	check('with no frontmatter both hashes agree', bare.body === bare.legacy);
	check('adding frontmatter to a bare note is not a change',
		!hasNoteChangedByHashes(store('a.md', bare.body), 'a.md', computeNoteHashes(plain)));
}

console.log(fail === 0 ? 'hashes: all checks passed' : `${fail} FAILURES`);
process.exit(fail ? 1 : 0);
