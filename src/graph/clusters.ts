/**
 * Community detection for the graph view.
 *
 * Louvain (graphology's implementation, the same ecosystem as the FA2 layout)
 * over the visible graph. The result colours nodes, names the clusters in the
 * view's legend, and lets the layout gather each one together.
 *
 * Deliberately free of obsidian and cytoscape imports, like layout.ts.
 */
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

export interface ClusterEdge {
	source: string;
	target: string;
}

export interface Cluster {
	/** Position in the size ordering; 0 is the largest. */
	index: number;
	members: string[];
}

export interface ClusterResult {
	/** Cluster index per node, or -1 for a node in a cluster too small to show. */
	clusterOf: Map<string, number>;
	/** Clusters of at least MIN_CLUSTER_SIZE, largest first. */
	clusters: Cluster[];
}

/**
 * Smaller groups are not reported as clusters. Louvain puts every isolate and
 * every dangling pair in its own community, and on a real vault that is
 * hundreds of one- and two-node "clusters" that would drown the legend and
 * exhaust any palette.
 */
export const MIN_CLUSTER_SIZE = 3;

/** Seeded PRNG (mulberry32) so the same graph always yields the same clusters. */
function seededRandom(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function detectClusters(
	nodeIds: readonly string[],
	edges: readonly ClusterEdge[],
	resolution = 1
): ClusterResult {
	// Louvain refuses multigraphs, and the graph can hold parallel edges (two
	// verbs between the same pair). Collapse them into one weighted edge.
	const graph = new Graph({ type: 'undirected' });
	for (const id of nodeIds) graph.mergeNode(id);
	for (const e of edges) {
		if (e.source === e.target || !graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
		graph.updateEdge(e.source, e.target, attr => ({ weight: ((attr.weight as number | undefined) ?? 0) + 1 }));
	}

	const communities = graph.size > 0
		? louvain(graph, { resolution, getEdgeWeight: 'weight', rng: seededRandom(0x5eed) })
		: {};

	const groups = new Map<number, string[]>();
	for (const id of nodeIds) {
		const community = communities[id];
		if (community === undefined) continue;
		const group = groups.get(community);
		if (group) group.push(id);
		else groups.set(community, [id]);
	}

	const ordered = [...groups.values()]
		.filter(members => members.length >= MIN_CLUSTER_SIZE)
		.map(members => members.sort())
		.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));

	const clusterOf = new Map<string, number>(nodeIds.map(id => [id, -1]));
	const clusters: Cluster[] = ordered.map((members, index) => {
		for (const id of members) clusterOf.set(id, index);
		return { index, members };
	});
	return { clusterOf, clusters };
}

/** Colour for a node outside every reported cluster. */
export const UNCLUSTERED_COLOR = '#94a3b8';

/**
 * Distinct colour per cluster index: golden-angle hue steps keep neighbouring
 * indices far apart on the wheel, and the lightness bands keep the twelfth
 * cluster from looking like the first.
 */
export function clusterColor(index: number): string {
	if (index < 0) return UNCLUSTERED_COLOR;
	const hue = Math.round((index * 137.508) % 360);
	const lightness = [55, 45, 65][Math.floor(index / 12) % 3];
	return `hsl(${hue}, 65%, ${lightness}%)`;
}
