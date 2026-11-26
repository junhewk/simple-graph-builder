/**
 * Hash records must match a note whichever Unicode form its path arrives in.
 *
 * macOS can store Korean file names decomposed (NFD), and Obsidian versions,
 * platforms and synced copies of data.json need not agree on the form a path
 * is reported in. Records used to be matched with ===, so a record written in
 * one form was invisible to a lookup in the other: the note looked new, the
 * next vault analysis paid to extract it again, and the old record stayed
 * behind as an orphan. Everything else in the plugin already compares in NFC.
 */
import { fakePluginWithData } from './graph-harness';
import {
	computeNoteHashes, getNoteHash, hasNoteChangedByHashes, healHashRecords, HashRenameQueue, loadHashes,
	normalizeHashData, recordNoteHash, removeNoteHash, renameNoteHash, updateNoteHash, upgradeLegacyHash, computeHash,
} from '../src/graph/hashes';
import type { HashData } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const NFC = '20. Meetings/240117 CODA 회의.md';
const NFD = NFC.normalize('NFD');
const RENAMED = '30. Archive/240117 CODA 회의록.md';
const BODY = '# 회의\n\nCODA 프로젝트 일정과 담당자를 정했다.\n';
const current = computeNoteHashes(BODY);

const one = (path: string, hash = current.body, analyzedAt = 1): HashData => ({ hashes: [{ path, hash, analyzedAt }] });
const records = (data: unknown) => ((data as { hashes: HashData }).hashes.hashes);

async function main() {
	check('the two forms really differ', NFC !== NFD && NFD.normalize('NFC') === NFC);

	// --- every lookup, in both directions ------------------------------------
	for (const [stored, asked, name] of [[NFD, NFC, 'NFD record, NFC lookup'], [NFC, NFD, 'NFC record, NFD lookup']]) {
		check(`${name}: found`, getNoteHash(one(stored), asked)?.hash === current.body);
		check(`${name}: compared as unchanged`, !hasNoteChangedByHashes(one(stored), asked, current));
		check(`${name}: a body edit still registers`,
			hasNoteChangedByHashes(one(stored), asked, computeNoteHashes(`${BODY}\n추가 문장.\n`)));

		const legacy = one(stored, computeHash(`---\ntags: [x]\n---\n${BODY}`));
		check(`${name}: legacy hash upgraded`,
			upgradeLegacyHash(legacy, asked, computeNoteHashes(`---\ntags: [x]\n---\n${BODY}`)) && legacy.hashes[0].hash === current.body);

		const updated = updateNoteHash(one(stored, 'old'), asked, 'new');
		check(`${name}: update replaces, never duplicates`, updated.hashes.length === 1 && updated.hashes[0].hash === 'new');
		check(`${name}: update stores the NFC path`, updated.hashes[0].path === NFC);

		const renamed = one(stored);
		check(`${name}: rename finds it`, renameNoteHash(renamed, asked, RENAMED.normalize('NFD')));
		check(`${name}: renamed record stored in NFC`, renamed.hashes.length === 1 && renamed.hashes[0].path === RENAMED);

		const removed = one(stored);
		check(`${name}: remove finds it`, removeNoteHash(removed, asked) && removed.hashes.length === 0);
	}

	check('remove reports a missing record', !removeNoteHash(one(NFC), 'other.md'));
	check('rename of an unknown note changes nothing', !renameNoteHash(one(NFC), 'other.md', 'moved.md'));
	{
		const sameName = one(NFD);
		check('a rename that only changes the form is stored in NFC',
			renameNoteHash(sameName, NFD, NFC) && sameName.hashes[0].path === NFC);
	}
	{
		// Deleting a note leaves its record; a note later renamed onto that path
		// must not end up with two records, the stale one found first.
		const hashes: HashData = { hashes: [
			{ path: RENAMED, hash: 'stale', analyzedAt: 9 },
			{ path: NFD, hash: current.body, analyzedAt: 1 },
		] };
		renameNoteHash(hashes, NFC, RENAMED);
		check('rename onto a stale record replaces it',
			hashes.hashes.length === 1 && getNoteHash(hashes, RENAMED)?.hash === current.body, JSON.stringify(hashes));
	}

	// --- healing what is already on disk -------------------------------------
	for (const [first, second, name] of [[NFC, NFD, 'NFC first'], [NFD, NFC, 'NFD first']]) {
		const { plugin, latest, saved } = fakePluginWithData({
			settings: { relatedPropertyName: 'related' },
			hashes: { hashes: [
				{ path: 'a.md', hash: 'a', analyzedAt: 5 },
				{ path: first, hash: 'older', analyzedAt: 100 },
				{ path: 'b.md', hash: 'b', analyzedAt: 6 },
				{ path: second, hash: 'newer', analyzedAt: 200 },
			] },
		});
		check(`${name}: healing rewrites data.json`, await healHashRecords(plugin) && saved.length === 1);
		const healed = records(latest());
		check(`${name}: duplicates fold into one record`, healed.length === 3, JSON.stringify(healed));
		check(`${name}: the newest analysis wins`, getNoteHash({ hashes: healed }, NFC)?.hash === 'newer');
		check(`${name}: stored under NFC`, healed.some(h => h.path === NFC) && !healed.some(h => h.path === NFD));
		check(`${name}: other records untouched`, getNoteHash({ hashes: healed }, 'a.md')?.hash === 'a' && getNoteHash({ hashes: healed }, 'b.md')?.analyzedAt === 6);
		check(`${name}: other keys untouched`, (latest() as { settings: { relatedPropertyName: string } }).settings.relatedPropertyName === 'related');
		check(`${name}: healing again is a no-op`, !(await healHashRecords(plugin)) && saved.length === 1);
	}
	{
		const { plugin, saved } = fakePluginWithData({ hashes: { hashes: [{ path: NFC, hash: 'x', analyzedAt: 1 }] } });
		check('clean data is not rewritten at load', !(await healHashRecords(plugin)) && saved.length === 0);
		const empty = fakePluginWithData();
		check('a fresh install gets no data.json from healing', !(await healHashRecords(empty.plugin)) && empty.saved.length === 0);
	}
	{
		const dupes: HashData = { hashes: [{ path: NFD, hash: 'n', analyzedAt: 1 }, { path: NFC, hash: 'c', analyzedAt: 1 }] };
		check('a tie keeps the first record', normalizeHashData(dupes) && dupes.hashes.length === 1 && dupes.hashes[0].hash === 'n');
	}

	// --- through data.json, as the commands see it ----------------------------
	{
		const { plugin, latest } = fakePluginWithData({ hashes: { hashes: [{ path: NFD, hash: current.body, analyzedAt: 1 }] } });
		const loaded = await loadHashes(plugin);
		check('a loaded NFD record reads as NFC', loaded.hashes[0].path === NFC);
		check('so the note counts as analyzed', !hasNoteChangedByHashes(loaded, NFC, current));

		await recordNoteHash(plugin, NFC, 'reanalyzed');
		check('recording over an NFD record leaves one record', records(latest()).length === 1 && records(latest())[0].hash === 'reanalyzed');

		await new HashRenameQueue(plugin).follow(NFD, RENAMED);
		check('a rename reported in NFD moves the NFC record', records(latest()).length === 1 && records(latest())[0].path === RENAMED);
	}

	console.log(fail === 0 ? 'hash-unicode: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
