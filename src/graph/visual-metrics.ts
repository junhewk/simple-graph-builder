/**
 * Connectivity-derived values used to style the rendered graph.
 *
 * These metrics deliberately operate on the final visible graph rather than
 * persisted graph data. A hidden note layer, minimum-degree filter, or render
 * budget therefore cannot make a node look important because of edges that
 * are not actually on screen.
 */

export interface VisualMetricEdge {
	id: string;
	source: string;
	target: string;
}

export interface NodeVisualMetrics {
	degree: number;
	importance: number;
	size: number;
	emphasizedSize: number;
}

export interface EdgeVisualMetrics {
	importance: number;
	opacity: number;
	overviewOpacity: number;
}

export interface GraphVisualMetrics {
	nodes: Map<string, NodeVisualMetrics>;
	edges: Map<string, EdgeVisualMetrics>;
}

const NODE_SIZE_MIN = 12;
const LARGE_NODE_SIZE_MIN = 14;
const NODE_SIZE_MAX = 30;
const NODE_EMPHASIS_BONUS = 4;

const EDGE_OPACITY_MIN = 0.18;
const EDGE_OPACITY_MAX = 0.65;
const LARGE_EDGE_OPACITY_MIN = 0.12;
const LARGE_EDGE_OPACITY_MAX = 0.40;
const OVERVIEW_EDGE_OPACITY_MIN = 0.45;
const OVERVIEW_EDGE_OPACITY_MAX = 0.90;

function interpolate(min: number, max: number, amount: number): number {
	return min + (max - min) * amount;
}

/** Count visible incident edges for every supplied node, including isolates. */
export function countVisibleDegrees(
	nodeIds: readonly string[],
	edges: readonly VisualMetricEdge[]
): Map<string, number> {
	const degrees = new Map<string, number>(nodeIds.map(id => [id, 0]));
	for (const edge of edges) {
		if (degrees.has(edge.source)) {
			degrees.set(edge.source, degrees.get(edge.source)! + 1);
		}
		if (degrees.has(edge.target)) {
			degrees.set(edge.target, degrees.get(edge.target)! + 1);
		}
	}
	return degrees;
}

/**
 * Calculate bounded visual values from visible degree.
 *
 * log1p dampens hub-heavy degree distributions. Min/max normalization makes
 * the scale relative to the graph currently on screen; when there is no
 * spread, the midpoint is the only honest neutral value.
 */
export function computeGraphVisualMetrics(
	nodeIds: readonly string[],
	edges: readonly VisualMetricEdge[],
	isLargeGraph: boolean
): GraphVisualMetrics {
	const degrees = countVisibleDegrees(nodeIds, edges);

	const loggedDegrees = [...degrees.values()].map(degree => Math.log1p(degree));
	const minLogged = loggedDegrees.length > 0 ? Math.min(...loggedDegrees) : 0;
	const maxLogged = loggedDegrees.length > 0 ? Math.max(...loggedDegrees) : 0;
	const spread = maxLogged - minLogged;
	const nodeSizeMin = isLargeGraph ? LARGE_NODE_SIZE_MIN : NODE_SIZE_MIN;

	const nodes = new Map<string, NodeVisualMetrics>();
	for (const [id, degree] of degrees) {
		const importance = spread === 0
			? 0.5
			: (Math.log1p(degree) - minLogged) / spread;
		const size = interpolate(nodeSizeMin, NODE_SIZE_MAX, importance);
		nodes.set(id, {
			degree,
			importance,
			size,
			emphasizedSize: size + NODE_EMPHASIS_BONUS,
		});
	}

	const opacityMin = isLargeGraph ? LARGE_EDGE_OPACITY_MIN : EDGE_OPACITY_MIN;
	const opacityMax = isLargeGraph ? LARGE_EDGE_OPACITY_MAX : EDGE_OPACITY_MAX;
	const edgeMetrics = new Map<string, EdgeVisualMetrics>();
	for (const edge of edges) {
		const sourceImportance = nodes.get(edge.source)?.importance ?? 0;
		const targetImportance = nodes.get(edge.target)?.importance ?? 0;
		const importance = (sourceImportance + targetImportance) / 2;
		edgeMetrics.set(edge.id, {
			importance,
			opacity: interpolate(opacityMin, opacityMax, importance),
			overviewOpacity: interpolate(
				OVERVIEW_EDGE_OPACITY_MIN,
				OVERVIEW_EDGE_OPACITY_MAX,
				importance
			),
		});
	}

	return { nodes, edges: edgeMetrics };
}
