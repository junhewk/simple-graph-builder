/**
 * "Remove current note from graph" must clear the note's analysis record.
 *
 * It used to drop the record only when the note had put nodes or edges in the
 * graph. A note whose analysis found nothing -- a short prompt note, say --
 * kept its record, was told "This note is not in the graph", and stayed marked
 * analyzed for good: nothing short of clearing all data would let it be
 * analyzed again.
 */
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';
import { notices } from './obsidian-stub';
import { removeCurrentNoteFromGraph } from '../src/commands/analyze';
import type { HashData, OntologyNode } from '../src/types';

// Write-back cleanup yields through window.setTimeout; the harness stub never fires.
{
	const w = (globalThis as unknown as { window: Record<string, unknown> }).window;
	w.setTimeout = (fn: () => void, ms?: number) => setTimeout(fn, ms ?? 0);
	w.clearTimeout = (id: NodeJS.Timeout) => clearTimeout(id);
}

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const BODY = '# Prompt\n\nSummarize the attached meeting notes in three bullet points.\n';

async function setup(path: string, records: HashData['hashes'], nodes: OntologyNode[] = []) {
	const ctx = fakeSyncPlugin({ enableEntityNotes: false, enableRelatedWriteback: false });
	await ctx.graphCache.ensureLoaded();
	for (const node of nodes) ctx.graphCache.addNode(node);
	await ctx.graphCache.flush();
	await ctx.plugin.saveData({ ...ctx.latest(), hashes: { hashes: records } });
	const file = ctx.vault.seed(path, BODY);
	ctx.plugin.app.workspace = { getActiveViewOfType: () => ({ file }) } as never;
	ctx.plugin.updateStatusBar = () => undefined;
	notices.length = 0;
	return ctx;
}

const stored = (ctx: { latest: () => unknown }) => (ctx.latest() as { hashes: HashData }).hashes.hashes;

async function main() {
	{
		const ctx = await setup('prompts/short.md', [
			{ path: 'prompts/short.md', hash: 'h', analyzedAt: 1 },
			{ path: 'other.md', hash: 'o', analyzedAt: 2 },
		]);
		await removeCurrentNoteFromGraph(ctx.plugin);
		check('a note with a record but no graph data loses the record',
			!stored(ctx).some(h => h.path === 'prompts/short.md'), JSON.stringify(stored(ctx)));
		check('other records are kept', stored(ctx).length === 1 && stored(ctx)[0].path === 'other.md');
		check('the notice says the record was cleared', notices.some(n => n.includes('had no graph data') && n.includes('record was cleared')), notices.join(' | '));
	}

	{
		const path = '20. Meetings/240117 CODA 회의.md';
		const ctx = await setup(path, [{ path: path.normalize('NFD'), hash: 'h', analyzedAt: 1 }]);
		await removeCurrentNoteFromGraph(ctx.plugin);
		check('a record stored under the NFD path is cleared too', stored(ctx).length === 0, JSON.stringify(stored(ctx)));
	}

	{
		const node: OntologyNode = { id: 'concept:coda', entityType: 'CONCEPT', properties: { name: 'CODA' }, sourceNotes: ['notes/coda.md'] };
		const ctx = await setup('notes/coda.md', [{ path: 'notes/coda.md', hash: 'h', analyzedAt: 1 }], [node]);
		await removeCurrentNoteFromGraph(ctx.plugin);
		check('a note with graph data loses its nodes', ctx.graphCache.getNodesBySourceNote('notes/coda.md').length === 0);
		check('and its record', stored(ctx).length === 0);
		check('the notice counts what was removed', notices.some(n => n.includes('Removed') && n.includes('1 nodes')), notices.join(' | '));
	}

	{
		const ctx = await setup('notes/new.md', [{ path: 'other.md', hash: 'o', analyzedAt: 2 }]);
		const before = JSON.stringify(ctx.latest());
		await removeCurrentNoteFromGraph(ctx.plugin);
		check('a never-analyzed note says so', notices.some(n => n.includes('never analyzed')), notices.join(' | '));
		check('and nothing is written', JSON.stringify(ctx.latest()) === before);
	}

	console.log(fail === 0 ? 'remove-note: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
