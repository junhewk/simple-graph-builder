import { computeGraphVisualMetrics, VisualMetricEdge } from '../src/graph/visual-metrics';

let fail = 0;
const check = (name: string, condition: boolean, extra = '') => {
	if (!condition) fail++;
	console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${extra ? ` :: ${extra}` : ''}`);
};

const edges: VisualMetricEdge[] = [
	{ id: 'hub-a', source: 'hub', target: 'a' },
	{ id: 'hub-b', source: 'hub', target: 'b' },
	{ id: 'hub-mid', source: 'hub', target: 'mid' },
	{ id: 'mid-c', source: 'mid', target: 'c' },
];
const metrics = computeGraphVisualMetrics(['hub', 'mid', 'a', 'b', 'c', 'isolated'], edges, false);

check('degree counts both edge endpoints',
	metrics.nodes.get('hub')?.degree === 3 && metrics.nodes.get('mid')?.degree === 2);
check('isolated nodes retain degree zero', metrics.nodes.get('isolated')?.degree === 0);
check('node importance is monotonic with degree',
	metrics.nodes.get('hub')!.importance > metrics.nodes.get('mid')!.importance &&
	metrics.nodes.get('mid')!.importance > metrics.nodes.get('a')!.importance &&
	metrics.nodes.get('a')!.importance > metrics.nodes.get('isolated')!.importance);
check('ordinary node sizes stay within 12-30px',
	[...metrics.nodes.values()].every(metric => metric.size >= 12 && metric.size <= 30));
check('emphasis adds exactly 4px',
	[...metrics.nodes.values()].every(metric => metric.emphasizedSize === metric.size + 4));
check('ordinary edge opacities stay within 0.18-0.65',
	[...metrics.edges.values()].every(metric => metric.opacity >= 0.18 && metric.opacity <= 0.65));
check('overview edge opacities stay within 0.45-0.90',
	[...metrics.edges.values()].every(metric => metric.overviewOpacity >= 0.45 && metric.overviewOpacity <= 0.90));

const hubToHub = computeGraphVisualMetrics(
	['h1', 'h2', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'],
	[
		{ id: 'h1-h2', source: 'h1', target: 'h2' },
		{ id: 'h1-l1', source: 'h1', target: 'l1' },
		{ id: 'h1-l2', source: 'h1', target: 'l2' },
		{ id: 'h2-l3', source: 'h2', target: 'l3' },
		{ id: 'h2-l4', source: 'h2', target: 'l4' },
		{ id: 'l5-l6', source: 'l5', target: 'l6' },
	],
	false
);
check('hub-to-hub edge is stronger than hub-to-leaf',
	hubToHub.edges.get('h1-h2')!.opacity > hubToHub.edges.get('h2-l3')!.opacity);
check('hub-to-leaf edge is stronger than leaf-to-leaf',
	hubToHub.edges.get('h2-l3')!.opacity > hubToHub.edges.get('l5-l6')!.opacity);

const equal = computeGraphVisualMetrics(
	['a', 'b'],
	[{ id: 'a-b', source: 'a', target: 'b' }],
	false
);
check('equal degrees receive a finite neutral score',
	[...equal.nodes.values()].every(metric => metric.importance === 0.5 && Number.isFinite(metric.size)));

const large = computeGraphVisualMetrics(['a', 'b', 'c'], [
	{ id: 'a-b', source: 'a', target: 'b' },
	{ id: 'a-c', source: 'a', target: 'c' },
], true);
check('large graph node sizes stay within 14-30px',
	[...large.nodes.values()].every(metric => metric.size >= 14 && metric.size <= 30));
check('large graph edge opacities stay within 0.12-0.40',
	[...large.edges.values()].every(metric => metric.opacity >= 0.12 && metric.opacity <= 0.40));

const empty = computeGraphVisualMetrics([], [], false);
check('empty graph produces empty metric maps', empty.nodes.size === 0 && empty.edges.size === 0);

console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
process.exit(fail ? 1 : 0);
