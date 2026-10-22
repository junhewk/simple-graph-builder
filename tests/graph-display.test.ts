/**
 * Graph view display settings, cluster detection, and the edge weights that
 * let the force settings steer ForceAtlas2.
 */
import {
	DEFAULT_GRAPH_DISPLAY,
	DISPLAY_RANGES,
	colorToHex,
	edgeLengthFactor,
	normalizeGraphDisplay,
} from '../src/graph/display';
import { detectClusters, clusterColor, UNCLUSTERED_COLOR } from '../src/graph/clusters';
import { refineLayout, LayoutNode, LayoutEdge } from '../src/graph/layout';

let fail = 0;
const check = (name: string, condition: boolean, extra = '') => {
	if (!condition) fail++;
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${extra ? ` :: ${extra}` : ''}`);
};

// --- normalizeGraphDisplay ---

check('missing value normalizes to the defaults',
	JSON.stringify(normalizeGraphDisplay(undefined)) === JSON.stringify(DEFAULT_GRAPH_DISPLAY));

const partial = normalizeGraphDisplay({ nodeSize: 2 });
check('keys added since a value was saved fill in from defaults',
	partial.nodeSize === 2 && partial.repulsion === 1 && partial.colorBy === 'type');

const clamped = normalizeGraphDisplay({ nodeSize: 99, gravity: -4, edgeOpacity: Number.NaN });
check('out-of-range numbers clamp to their range',
	clamped.nodeSize === DISPLAY_RANGES.nodeSize.max && clamped.gravity === DISPLAY_RANGES.gravity.min);
check('non-finite numbers fall back to the default', clamped.edgeOpacity === DEFAULT_GRAPH_DISPLAY.edgeOpacity);

const junk = normalizeGraphDisplay({
	colorBy: 'rainbow',
	edgeColor: 'red',
	typeColors: { CONCEPT: '#123456', PERSON: 'blue', TOOL: 7 },
	hiddenTypes: ['NOTE', 'NOTE', 3],
	edgeLabels: 'yes',
});
check('unknown colour mode keeps the default', junk.colorBy === 'type');
check('non-hex edge colour is dropped', junk.edgeColor === '');
check('only hex type colours survive',
	JSON.stringify(junk.typeColors) === JSON.stringify({ CONCEPT: '#123456' }));
check('hidden types are deduplicated strings', JSON.stringify(junk.hiddenTypes) === JSON.stringify(['NOTE']));
check('non-boolean edgeLabels keeps the default', junk.edgeLabels === false);

const fresh = normalizeGraphDisplay(DEFAULT_GRAPH_DISPLAY);
fresh.typeColors.CONCEPT = '#000000';
fresh.hiddenTypes.push('NOTE');
check('normalizing the defaults never aliases their objects',
	Object.keys(DEFAULT_GRAPH_DISPLAY.typeColors).length === 0 && DEFAULT_GRAPH_DISPLAY.hiddenTypes.length === 0);

// --- colorToHex ---

check('hex passes through lowercased', colorToHex('#14B8A6') === '#14b8a6');
check('short hex expands', colorToHex('#abc') === '#aabbcc');
check('hsl converts (pure red)', colorToHex('hsl(0, 100%, 50%)') === '#ff0000');
check('hsl converts (getEntityTypeColor fallback shape)', /^#[0-9a-f]{6}$/.test(colorToHex('hsl(212, 70%, 60%)')),
	colorToHex('hsl(212, 70%, 60%)'));
check('cluster colours convert too', /^#[0-9a-f]{6}$/.test(colorToHex(clusterColor(5))));
check('garbage falls back to grey', colorToHex('not a colour') === '#94a3b8');

// --- edgeLengthFactor ---

const base = normalizeGraphDisplay({});
check('defaults leave edge length alone',
	edgeLengthFactor(base, true) === 1 && edgeLengthFactor(base, false) === 1);
check('link length scales every edge', edgeLengthFactor({ ...base, linkLength: 2 }, false) === 2);
const pulled = { ...base, clusterPull: 1 };
check('cluster pull shortens edges inside a cluster and lengthens those between',
	edgeLengthFactor(pulled, true) < 1 && edgeLengthFactor(pulled, false) > 1);

// --- detectClusters ---

// Two 5-cliques joined by one bridge, plus an isolate and a dangling pair
const clique = (prefix: string) => {
	const ids = [0, 1, 2, 3, 4].map(i => `${prefix}${i}`);
	const edges: { source: string; target: string }[] = [];
	for (let i = 0; i < ids.length; i++) {
		for (let j = i + 1; j < ids.length; j++) edges.push({ source: ids[i], target: ids[j] });
	}
	return { ids, edges };
};
const a = clique('a');
const b = clique('b');
const nodeIds = [...a.ids, ...b.ids, 'lonely', 'p1', 'p2'];
const edges = [
	...a.edges,
	...b.edges,
	{ source: 'a0', target: 'b0' },
	{ source: 'p1', target: 'p2' },
	// A parallel edge and a self-loop: real graphs have both, Louvain must not throw
	{ source: 'a1', target: 'a2' },
	{ source: 'a3', target: 'a3' },
];
const result = detectClusters(nodeIds, edges);

check('two cliques make two clusters', result.clusters.length === 2, String(result.clusters.length));
check('each clique is one cluster',
	new Set(a.ids.map(id => result.clusterOf.get(id))).size === 1 &&
	new Set(b.ids.map(id => result.clusterOf.get(id))).size === 1 &&
	result.clusterOf.get('a0') !== result.clusterOf.get('b0'));
check('isolates and pairs are unclustered',
	result.clusterOf.get('lonely') === -1 && result.clusterOf.get('p1') === -1 && result.clusterOf.get('p2') === -1);
check('every node gets an entry', nodeIds.every(id => result.clusterOf.has(id)));
check('cluster indices follow the ordering', result.clusters.every((c, i) => c.index === i));
check('same input gives the same clusters',
	JSON.stringify([...detectClusters(nodeIds, edges).clusterOf]) === JSON.stringify([...result.clusterOf]));
check('empty graph is fine', detectClusters([], []).clusters.length === 0);
check('edgeless graph is all unclustered',
	[...detectClusters(['x', 'y', 'z'], []).clusterOf.values()].every(c => c === -1));
check('unclustered colour is the neutral grey', clusterColor(-1) === UNCLUSTERED_COLOR);
check('neighbouring cluster colours differ', clusterColor(0) !== clusterColor(1));

// --- FA2 edge weights ---

// A star: hub plus 12 leaves, half of whose edges are weighted up
const star = async (heavy: number): Promise<{ light: number; heavy: number }> => {
	const nodes: LayoutNode[] = [{ id: 'hub', x: 0, y: 0, radius: 1 }];
	const starEdges: LayoutEdge[] = [];
	for (let i = 0; i < 12; i++) {
		const angle = (i / 12) * 2 * Math.PI;
		nodes.push({ id: `leaf${i}`, x: 100 * Math.cos(angle), y: 100 * Math.sin(angle), radius: 1 });
		starEdges.push({ source: 'hub', target: `leaf${i}`, weight: i % 2 === 0 ? heavy : 1 });
	}
	await refineLayout(nodes, starEdges, { schedule: cb => cb(), noverlapSweeps: 0 });
	const hub = nodes[0];
	const dist = (n: LayoutNode) => Math.hypot(n.x - hub.x, n.y - hub.y);
	const mean = (list: LayoutNode[]) => list.reduce((s, n) => s + dist(n), 0) / list.length;
	return {
		heavy: mean(nodes.slice(1).filter((_, i) => i % 2 === 0)),
		light: mean(nodes.slice(1).filter((_, i) => i % 2 === 1)),
	};
};

void (async () => {
	const uniform = await star(1);
	check('unweighted edges settle at one length',
		Math.abs(uniform.heavy - uniform.light) / uniform.light < 0.05,
		`${uniform.heavy.toFixed(1)} vs ${uniform.light.toFixed(1)}`);
	const weighted = await star(4);
	check('heavier edges settle shorter',
		weighted.heavy < weighted.light * 0.8,
		`${weighted.heavy.toFixed(1)} vs ${weighted.light.toFixed(1)}`);

	console.log(fail ? `\n${fail} failed` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
