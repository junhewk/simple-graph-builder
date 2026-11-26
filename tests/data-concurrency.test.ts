/**
 * Writers of data.json must not erase each other's changes.
 *
 * Settings, the graph and the note hash records share one file, which Obsidian
 * loads and saves whole. Each writer used to load it, change its part and save
 * it, with awaits in between, so the last save won: selecting several analyzed
 * notes and dragging them into a folder fired one rename per note, and all but
 * one of the moved hash records were lost. A debounced graph flush or a
 * settings save landing in the gap put stale data back the same way. A lost
 * record makes a note look new, and the next vault analysis pays to extract it
 * again.
 *
 * This drives the real entry points -- the rename handler, GraphCache.flush,
 * saveSettings -- against a store whose loads and saves take random time.
 */
import './graph-harness';
import SimpleGraphBuilderPlugin from '../src/main';
import { GraphCache } from '../src/graph/cache';
import { ImportRegistry } from '../src/import/registry';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { GraphData, HashData, OntologyNode } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

// Seeded, so a failure reproduces.
let seed = 0x5eed;
const random = () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const RENAMES = 50;
const from = (i: number) => `20. Meetings/회의 ${i}.md`;
const to = (i: number) => `30. Archive/회의 ${i}.md`;

/** data.json on a slow disk: reads and writes finish in random order. */
function slowStore(initial: Record<string, unknown>) {
	let stored = clone(initial);
	let saves = 0;
	return {
		loadData: async () => {
			await sleep(random() * 4);
			return clone(stored);
		},
		saveData: async (data: unknown) => {
			// Obsidian serializes at the call and writes afterwards.
			const text = JSON.stringify(data);
			await sleep(random() * 4);
			stored = JSON.parse(text) as Record<string, unknown>;
			saves++;
		},
		latest: () => stored,
		saves: () => saves,
	};
}

function initialData() {
	const hashes: HashData = { hashes: [] };
	const nodes: OntologyNode[] = [];
	for (let i = 0; i < RENAMES; i++) {
		hashes.hashes.push({ path: from(i), hash: `h${i}`, analyzedAt: i + 1 });
		nodes.push({ id: `concept:c${i}`, entityType: 'CONCEPT', properties: { name: `C${i}` }, sourceNotes: [from(i)] });
	}
	for (let i = 0; i < 10; i++) hashes.hashes.push({ path: `Untouched/${i}.md`, hash: `u${i}`, analyzedAt: 1000 + i });
	return {
		settings: { ...DEFAULT_SETTINGS, relatedPropertyName: 'related-start' },
		graph: { nodes, edges: [], version: 3 } as GraphData,
		hashes,
		resolutionCache: { c0: 'concept:c0' },
	};
}

async function main() {
	const store = slowStore(initialData());
	const app = { metadataCache: { getFirstLinkpathDest: () => null, resolvedLinks: {} } };
	const plugin = new SimpleGraphBuilderPlugin(app as never, { id: 'simple-graph-builder', dir: '.obsidian/plugins/simple-graph-builder' } as never);
	plugin.loadData = store.loadData;
	plugin.saveData = store.saveData;
	plugin.settings = { ...DEFAULT_SETTINGS, relatedPropertyName: 'related-start' };
	plugin.graphCache = new GraphCache(plugin);
	await plugin.graphCache.ensureLoaded();
	plugin.imports = new ImportRegistry({});
	const followRename = (plugin as unknown as { followRename(a: string, b: string): Promise<void> }).followRename.bind(plugin);

	const savesBefore = store.saves();
	const pending: Promise<unknown>[] = [];
	let lastSetting = 'related-start';
	for (let i = 0; i < RENAMES; i++) {
		// Most renames arrive in one burst, as a folder drag sends them; some
		// arrive while earlier writes are still in flight.
		if (random() < 0.3) await sleep(random() * 6);
		pending.push(followRename(from(i), to(i)));
		if (i % 5 === 2) pending.push(plugin.graphCache.flush());
		if (i % 7 === 3) {
			lastSetting = `related-${i}`;
			plugin.settings.relatedPropertyName = lastSetting;
			pending.push(plugin.saveSettings());
		}
	}
	// A chain inside the burst: the record must end at the last name.
	pending.push(followRename(to(0), 'Final/회의 0.md'));
	await Promise.all(pending);
	await plugin.graphCache.flush();

	const data = store.latest() as ReturnType<typeof initialData>;
	const paths = new Set(data.hashes.hashes.map(h => h.path));
	const landed = Array.from({ length: RENAMES }, (_, i) => i).filter(i => i === 0 ? paths.has('Final/회의 0.md') : paths.has(to(i)));
	check('every rename landed', landed.length === RENAMES, `${landed.length}/${RENAMES}`);
	check('no record left at an old path', ![...paths].some(p => p.startsWith('20. Meetings/')),
		[...paths].filter(p => p.startsWith('20. Meetings/')).length + ' left');
	check('a rename chain ends at its last name', paths.has('Final/회의 0.md') && !paths.has(to(0)));
	check('each moved record kept its hash', data.hashes.hashes.every(h => !h.path.includes('회의') || h.hash === `h${/회의 (\d+)/.exec(h.path)?.[1]}`));
	check('unrelated records survived', Array.from({ length: 10 }, (_, i) => `Untouched/${i}.md`).every(p => paths.has(p)));
	check('no record was duplicated', data.hashes.hashes.length === RENAMES + 10, String(data.hashes.hashes.length));
	check('the last settings save survived', data.settings.relatedPropertyName === lastSetting, data.settings.relatedPropertyName);
	check('the graph followed the renames', data.graph.nodes.every(n => n.sourceNotes.every(p => !p.startsWith('20. Meetings/'))));
	check('the resolution cache survived', data.resolutionCache?.c0 === 'concept:c0');
	// One write per rename would rewrite a multi-megabyte file per note moved.
	const writes = store.saves() - savesBefore;
	check('renames in a burst share writes', writes < RENAMES, `${writes} saves`);

	console.log(fail === 0 ? 'data-concurrency: all checks passed' : `${fail} FAILURES`);
	process.exit(fail ? 1 : 0);
}

void main();
