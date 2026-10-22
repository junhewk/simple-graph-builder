/**
 * Remembered graph-view positions: the file format, and where nodes the map
 * doesn't know yet are placed.
 */
import {
	PositionMap,
	PositionStore,
	parsePositions,
	placeNewNodes,
	serializePositions,
} from '../src/graph/positions';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

(async () => {
	// --- file format ---
	const map: PositionMap = new Map([['a', { x: 1.234, y: -5.678 }], ['노트/b.md', { x: 100, y: 200 }]]);
	const round = parsePositions(serializePositions(map));
	check('round trip keeps ids, including non-ASCII paths', round.size === 2 && round.has('노트/b.md'));
	check('coordinates are kept to one decimal', round.get('a')?.x === 1.2 && round.get('a')?.y === -5.7);
	check('missing file is an empty map', parsePositions(null).size === 0);
	check('garbage is an empty map, not an error', parsePositions('{not json').size === 0);
	check('another format version is ignored', parsePositions('{"version":99,"positions":{"a":[1,2]}}').size === 0);
	check('malformed entries are skipped, good ones kept',
		parsePositions('{"version":1,"positions":{"a":[1,2],"b":[1],"c":["x",2],"d":[null,1],"e":[3,4]}}').size === 2);

	// --- placement ---
	const known: PositionMap = new Map([['hub', { x: 0, y: 0 }], ['far', { x: 1000, y: 0 }]]);
	const edges = [
		{ source: 'hub', target: 'n1' },
		{ source: 'hub', target: 'n2' },
		{ source: 'n2', target: 'n3' },        // two steps from the known graph
		{ source: 'n4', target: 'far' },
		{ source: 'n4', target: 'hub' },       // between two known nodes
		{ source: 'island1', target: 'island2' }, // no tie to the map at all
	];
	const ids = ['hub', 'far', 'n1', 'n2', 'n3', 'n4', 'island1', 'island2'];
	const placed = placeNewNodes(ids, edges, known, 40);
	const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

	check('only unknown nodes are placed', !placed.has('hub') && !placed.has('far') && placed.size === 6, String(placed.size));
	check('a newcomer lands beside its known neighbour', dist(placed.get('n1')!, known.get('hub')!) < 100,
		dist(placed.get('n1')!, known.get('hub')!).toFixed(1));
	check('a newcomer two steps out lands beside the newcomer it hangs off',
		dist(placed.get('n3')!, placed.get('n2')!) < 100, dist(placed.get('n3')!, placed.get('n2')!).toFixed(1));
	check('a node tied to two known nodes lands between them',
		Math.abs(placed.get('n4')!.x - 500) < 100, placed.get('n4')!.x.toFixed(1));
	check('siblings do not stack', dist(placed.get('n1')!, placed.get('n2')!) > 1);
	check('unconnected newcomers go outside the known layout',
		dist(placed.get('island1')!, { x: 500, y: 0 }) > 500 && dist(placed.get('island2')!, { x: 500, y: 0 }) > 500);
	check('placement is deterministic',
		JSON.stringify([...placeNewNodes(ids, edges, known, 40)]) === JSON.stringify([...placed]));
	check('nothing new, nothing placed', placeNewNodes(['hub', 'far'], edges, known, 40).size === 0);
	check('no known nodes still places everything',
		placeNewNodes(['x', 'y'], [{ source: 'x', target: 'y' }], new Map(), 40).size === 2);

	// --- store ---
	let written: string | null = '{"version":1,"positions":{"kept":[1,2],"gone":[3,4],"filtered":[5,6]}}';
	let reads = 0;
	const store = new PositionStore({
		read: async () => { reads++; return written; },
		write: async text => { written = text; },
	});
	await store.load();
	await store.load();
	check('the file is read once', reads === 1);
	check('loaded positions are served', store.get('kept')?.x === 1 && store.size === 3);
	store.update([['new', { x: 9, y: 9 }]]);
	await store.save(new Set(['kept', 'filtered', 'new']));
	const saved = parsePositions(written);
	check('save prunes nodes gone from the graph', !saved.has('gone'));
	check('save keeps nodes that are only filtered out of view', saved.has('filtered'));
	check('save writes updates', saved.get('new')?.x === 9);

	const broken = new PositionStore({ read: async () => { throw new Error('disk'); }, write: async () => undefined });
	await broken.load();
	check('a failed read leaves an empty store', broken.size === 0);

	console.log(fail ? `\n${fail} failed` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
