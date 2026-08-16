/**
 * Force refinement for large-graph layouts, using Gephi's force model.
 *
 * fCoSE 'draft' quality does spectral placement only. Spectral coordinates
 * come from a handful of eigenvectors, so structurally equivalent nodes --
 * every entity hanging off one note hub, say -- land on *identical*
 * coordinates. On a real 2263-node vault only ~4% of positions were distinct.
 * The CoSE refinement pass that would separate them is quadratic (38s at 2500
 * nodes, 164s at 5177), and the 0.5.1 stopgap -- snapping stacked nodes onto a
 * 60px grid -- made every node visible but produced a uniform lattice with no
 * cluster structure: repulsion was never actually applied.
 *
 * This module refines the spectral seed with ForceAtlas2 (the graphology
 * implementation, the same code the Gephi ecosystem runs). FA2's repulsion is
 * weighted by (degree+1) on *both* endpoints, which is what gives Gephi
 * layouts their look: hubs clear space around themselves and clusters come
 * out as organic lobes instead of a hairball. The two phases mirror the
 * Gephi workflow -- run FA2, then a Noverlap pass that pushes any still
 * overlapping nodes apart so each ends up individually visible with room for
 * its label. (FA2's own adjustSizes mode was tried for that second phase and
 * measured useless here: on a stacked spectral seed its adaptive speeds damp
 * the correction to nothing -- 3% of nodes visible after 100 iterations, and
 * *still* 3% after 300.)
 *
 * Deliberately free of obsidian and cytoscape imports: the caller passes plain
 * positions in, gets refined positions out, and the test suite can bundle this
 * file directly and run it under node.
 */
import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';

/** Position record, mutated in place by refineLayout. */
export interface LayoutNode {
	id: string;
	x: number;
	y: number;
	/** Half the space this node needs, label included; enforced by the overlap phase. */
	radius: number;
}

export interface LayoutEdge {
	source: string;
	target: string;
}

export interface RefineOptions {
	/** FA2 repulsion scaling (Gephi's "Scaling"). More spreads everything out. */
	scalingRatio?: number;
	/** Pull toward the origin (Gephi's "Gravity", strong mode); keeps loose branches from flying off. */
	gravity?: number;
	/** FA2 iterations spent untangling structure. Zero runs the spacing pass alone, for a seed that is already force-refined. */
	structureTicks?: number;
	/** Upper bound on Noverlap relaxation sweeps; stops early once nothing overlaps. */
	noverlapSweeps?: number;
	/** Iterations run between scheduler yields. */
	ticksPerSlice?: number;
	/** Yield point between slices; defaults to requestAnimationFrame, or setTimeout under node. */
	schedule?: (cb: () => void) => void;
	/** Checked between slices; return true to abandon the refinement. */
	shouldStop?: () => boolean;
}

const DEFAULTS = {
	// graphology's inferSettings() recommends scalingRatio 10, but that packs
	// dense cores so tight the Noverlap pass has to inflate them back out,
	// distorting FA2's structure; 30 leaves the cores loose enough to mostly
	// keep their shape. Gravity per inferSettings.
	scalingRatio: 30,
	gravity: 0.05,
	structureTicks: 300,
	// Sweeps stop as soon as nothing overlaps, so this is a safety bound, not
	// a cost: after prescale most layouts converge in a handful.
	noverlapSweeps: 400,
	ticksPerSlice: 20,
};

/** Padding between component bounding boxes when they need packing apart. */
const COMPONENT_PAD = 90;

/**
 * Centre-to-centre spacing to aim for, given how many nodes there are.
 *
 * Labels ellipsize at 80px, so 80px of separation is what keeps them from
 * colliding -- but enforcing that on a big graph is self-defeating. Spacing
 * sets the layout's total size, the view fits that to the pane, and past a
 * few thousand nodes the fit zoom gets so small that every node renders
 * sub-pixel: a 5000-node vault came out 21000px wide, fitted at zoom 0.02,
 * and looked like an empty screen. Labels are hidden at that zoom anyway
 * (min-zoomed-font-size), so the space bought nothing.
 *
 * So spacing is the label budget until the graph is too big to show at a
 * legible scale, then it shrinks to hold the layout inside that budget.
 * Large graphs are read by zooming in, where the smaller spacing is still
 * ample: 40px at zoom 2 is 80px of screen.
 */
export function spacingForNodeCount(count: number): number {
	// Widest layout that still renders nodes as visible dots once fitted:
	// a 12px node in a ~1000px pane needs roughly this to stay above a pixel.
	const OVERVIEW_EXTENT_BUDGET = 8000;
	// Measured ratio of a finished layout's extent to a square packing of the
	// same node count and spacing -- clusters leave voids and the boundary is
	// ragged, so an organic layout is several times less compact. Ranges 4.1
	// (500 nodes) to 5.2 (5000); the upper end keeps the estimate safe.
	const LAYOUT_SPARSITY = 5;
	// Enough for a label; never worth exceeding.
	const MAX_SPACING = 80;
	// Enough to keep a 16px node clear of its neighbour, whatever the size.
	const MIN_SPACING = 30;

	if (count < 2) return MAX_SPACING;
	const affordable = OVERVIEW_EXTENT_BUDGET / (LAYOUT_SPARSITY * Math.sqrt(count));
	return Math.max(MIN_SPACING, Math.min(MAX_SPACING, affordable));
}

function defaultSchedule(cb: () => void): void {
	if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
		window.requestAnimationFrame(() => cb());
	} else if (typeof window !== 'undefined') {
		window.setTimeout(cb, 0);
	} else {
		// Headless layout tests run without a DOM window.
		globalThis.setTimeout(cb, 0);
	}
}

/** Union-find, path-halving. Returns a component index per node position. */
export function findComponents(nodes: LayoutNode[], edges: LayoutEdge[]): number[] {
	const index = new Map<string, number>();
	nodes.forEach((n, i) => index.set(n.id, i));

	const parent = nodes.map((_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};

	for (const e of edges) {
		const a = index.get(e.source);
		const b = index.get(e.target);
		if (a === undefined || b === undefined) continue;
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	}

	return nodes.map((_, i) => find(i));
}

/**
 * Give every node a unique position before simulating.
 *
 * FA2 skips force application between nodes at *exactly* the same point
 * (every force is gated by distance > 0), so the coincident stacks a spectral
 * seed produces would never separate. Members of a stack are fanned out on a
 * small golden-angle spiral -- deterministic, and small enough not to disturb
 * the seed's global shape.
 */
function separateCoincident(positions: Array<{ x: number; y: number }>): void {
	const seen = new Map<string, number>();
	const GOLDEN_ANGLE = 2.399963229728653;
	for (const p of positions) {
		const key = `${p.x},${p.y}`;
		const stackIndex = seen.get(key) || 0;
		seen.set(key, stackIndex + 1);
		if (stackIndex === 0) continue;
		const r = 2 * Math.sqrt(stackIndex);
		p.x += r * Math.cos(stackIndex * GOLDEN_ANGLE);
		p.y += r * Math.sin(stackIndex * GOLDEN_ANGLE);
	}
}

interface PackNode {
	x: number;
	y: number;
	radius: number;
	component: number;
}

/**
 * Scale the layout up until typical spacing clears the collision radii,
 * before relaxation has to do it.
 *
 * Uniform scaling is a similarity transform: it changes no ratio in the
 * layout, so the force pass's cluster structure survives exactly. Relaxation
 * alone would have to inflate dense cores from the inside, which distorts --
 * on an 871-node fCoSE layout that pushed mean edge length from 2.1x to 6.4x
 * ideal and degraded cluster separation from 0.42 to 0.60.
 *
 * Scales by what the 25th-percentile nearest-neighbour distance needs, so
 * most nodes land clear in one step and relaxation only fixes the residue.
 * Never shrinks a layout that is already roomy.
 */
function prescale(nodes: PackNode[], maxFactor = 8): void {
	const required = 2 * nodes.reduce((m, n) => Math.max(m, n.radius), 0);
	if (required <= 0) return;

	// Cell == required, so every pair closer than that shares a cell or borders one
	const grid = new Map<string, PackNode[]>();
	for (const n of nodes) {
		const key = `${Math.floor(n.x / required)},${Math.floor(n.y / required)}`;
		const bucket = grid.get(key);
		if (bucket) bucket.push(n);
		else grid.set(key, [n]);
	}

	const nearest: number[] = [];
	for (const a of nodes) {
		const cx = Math.floor(a.x / required);
		const cy = Math.floor(a.y / required);
		let best = required;
		for (let dx = -1; dx <= 1; dx++) {
			for (let dy = -1; dy <= 1; dy++) {
				for (const b of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
					if (b === a) continue;
					const d = Math.hypot(b.x - a.x, b.y - a.y);
					if (d < best) best = d;
				}
			}
		}
		nearest.push(best);
	}

	nearest.sort((a, b) => a - b);
	const p25 = nearest[Math.floor(nearest.length * 0.25)];
	if (p25 <= 0 || p25 >= required) return;

	const factor = Math.min(required / p25, maxFactor);
	if (factor <= 1) return;

	let cx = 0, cy = 0;
	for (const n of nodes) {
		cx += n.x;
		cy += n.y;
	}
	cx /= nodes.length;
	cy /= nodes.length;

	for (const n of nodes) {
		n.x = cx + (n.x - cx) * factor;
		n.y = cy + (n.y - cy) * factor;
	}
}

/**
 * Gephi-style Noverlap: iteratively push overlapping pairs apart until every
 * pair keeps radius+radius of separation. Gauss-Seidel relaxation over a
 * spatial hash grid, so each sweep is O(n) and convergence is quick -- dense
 * cores cascade outward over a few dozen sweeps. Deterministic: nodes are
 * processed in index order and pairs once each.
 *
 * @returns the number of sweeps that still found an overlap.
 */
function resolveOverlaps(nodes: PackNode[], maxSweeps: number): number {
	const maxRadius = nodes.reduce((m, n) => Math.max(m, n.radius), 0);
	const cell = 2 * maxRadius;
	if (cell <= 0) return 0;

	// Exact contact re-detects as overlap through float noise; keep a hair of
	// clearance beyond the radii.
	const slack = 0.5;

	let sweep = 0;
	for (; sweep < maxSweeps; sweep++) {
		const grid = new Map<string, number[]>();
		for (let i = 0; i < nodes.length; i++) {
			const key = `${Math.floor(nodes[i].x / cell)},${Math.floor(nodes[i].y / cell)}`;
			const bucket = grid.get(key);
			if (bucket) bucket.push(i);
			else grid.set(key, [i]);
		}

		let moved = false;
		for (let i = 0; i < nodes.length; i++) {
			const a = nodes[i];
			const cx = Math.floor(a.x / cell);
			const cy = Math.floor(a.y / cell);
			for (let dx = -1; dx <= 1; dx++) {
				for (let dy = -1; dy <= 1; dy++) {
					const bucket = grid.get(`${cx + dx},${cy + dy}`);
					if (!bucket) continue;
					for (const j of bucket) {
						if (j <= i) continue;
						const b = nodes[j];
						const need = a.radius + b.radius + slack;
						const ddx = b.x - a.x;
						const ddy = b.y - a.y;
						const dist = Math.hypot(ddx, ddy);
						if (dist >= need) continue;
						moved = true;
						if (dist > 0) {
							const push = (need - dist) / 2 / dist;
							a.x -= ddx * push;
							a.y -= ddy * push;
							b.x += ddx * push;
							b.y += ddy * push;
						} else {
							// Coincident pair: split along a direction derived from
							// the indices so the result stays deterministic
							const theta = (i * 31 + j) * 2.399963229728653;
							a.x -= (need / 2) * Math.cos(theta);
							a.y -= (need / 2) * Math.sin(theta);
							b.x += (need / 2) * Math.cos(theta);
							b.y += (need / 2) * Math.sin(theta);
						}
					}
				}
			}
		}
		if (!moved) break;
	}
	return sweep;
}

/**
 * Translate components apart if any of their (padded) bounding boxes overlap
 * after refinement. FA2's gravity pulls disconnected satellites toward the
 * main component, so this usually fires on graphs that have them. Shelf
 * packing: rows of decreasing-area boxes, row width bounded near the square
 * root of the total area so the result stays roughly square. Deterministic.
 */
function packOverlappingComponents(nodes: PackNode[], pad: number): void {
	interface Box { comp: number; x1: number; y1: number; x2: number; y2: number; w: number; h: number }

	const byComp = new Map<number, PackNode[]>();
	for (const n of nodes) {
		let group = byComp.get(n.component);
		if (!group) byComp.set(n.component, group = []);
		group.push(n);
	}
	if (byComp.size < 2) return;

	const boxes: Box[] = [];
	for (const [comp, group] of byComp) {
		let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
		for (const n of group) {
			x1 = Math.min(x1, n.x - n.radius);
			y1 = Math.min(y1, n.y - n.radius);
			x2 = Math.max(x2, n.x + n.radius);
			y2 = Math.max(y2, n.y + n.radius);
		}
		x1 -= pad; y1 -= pad; x2 += pad; y2 += pad;
		boxes.push({ comp, x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 });
	}

	let overlaps = false;
	outer: for (let i = 0; i < boxes.length; i++) {
		for (let j = i + 1; j < boxes.length; j++) {
			const a = boxes[i], b = boxes[j];
			if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) {
				overlaps = true;
				break outer;
			}
		}
	}
	if (!overlaps) return;

	boxes.sort((a, b) => (b.w * b.h) - (a.w * a.h) || a.comp - b.comp);
	const totalArea = boxes.reduce((sum, b) => sum + b.w * b.h, 0);
	const rowLimit = Math.max(Math.sqrt(totalArea) * 1.2, boxes[0].w);

	// A few pixels of slack between shelf cells: boxes packed *exactly*
	// touching can re-measure as overlapping by a float rounding error once
	// the translated node positions are re-aggregated.
	const gap = 4;

	let cursorX = 0, cursorY = 0, rowHeight = 0;
	for (const box of boxes) {
		if (cursorX > 0 && cursorX + box.w > rowLimit) {
			cursorX = 0;
			cursorY += rowHeight + gap;
			rowHeight = 0;
		}
		const dx = cursorX - box.x1;
		const dy = cursorY - box.y1;
		if (dx !== 0 || dy !== 0) {
			for (const n of byComp.get(box.comp) as PackNode[]) {
				n.x += dx;
				n.y += dy;
			}
		}
		cursorX += box.w + gap;
		rowHeight = Math.max(rowHeight, box.h);
	}
}

/**
 * Refine seeded positions with ForceAtlas2, in place.
 *
 * `structureTicks` iterations of FA2 let the degree-weighted repulsion
 * untangle the seed into cluster lobes, then a Noverlap relaxation guarantees
 * each node keeps `radius` of clearance -- the label budget. Iterations run
 * in slices with a scheduler yield between them so a loading indicator stays
 * live.
 *
 * Deterministic for a given input: FA2 uses no randomness, and the
 * coincident-stack fan-out is index-based.
 *
 * @returns true when the refinement ran to completion, false if `shouldStop`
 * cancelled it (the input positions are then left untouched).
 */
export async function refineLayout(
	nodes: LayoutNode[],
	edges: LayoutEdge[],
	opts: RefineOptions = {}
): Promise<boolean> {
	if (nodes.length < 2) return true;

	const o = { ...DEFAULTS, ...opts };
	const schedule = opts.schedule ?? defaultSchedule;
	const shouldStop = opts.shouldStop ?? (() => false);

	const positions = nodes.map(n => ({ x: n.x, y: n.y }));
	separateCoincident(positions);

	if (o.structureTicks > 0) {
		// Parallel edges and self-loops may exist in real data; 'multi' accepts
		// them rather than throwing, and FA2 simply skips zero-distance forces.
		const graph = new Graph({ multi: true, type: 'undirected' });
		nodes.forEach((n, i) => {
			graph.addNode(n.id, { x: positions[i].x, y: positions[i].y, size: n.radius });
		});
		for (const e of edges) {
			if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
				graph.addEdge(e.source, e.target);
			}
		}

		const settings = {
			scalingRatio: o.scalingRatio,
			gravity: o.gravity,
			strongGravityMode: true,
			// Exact repulsion is O(n^2) per iteration; Barnes-Hut keeps large
			// graphs affordable and the seed already fixed the global shape.
			barnesHutOptimize: nodes.length > 500,
			slowDown: 1 + Math.log(nodes.length),
		};

		let remaining = o.structureTicks;
		while (remaining > 0) {
			if (shouldStop()) return false;
			const slice = Math.min(o.ticksPerSlice, remaining);
			forceAtlas2.assign(graph, { iterations: slice, settings });
			remaining -= slice;
			if (remaining > 0) {
				await new Promise<void>(resolve => schedule(resolve));
			}
		}

		nodes.forEach((n, i) => {
			const attrs = graph.getNodeAttributes(n.id) as { x: number; y: number };
			positions[i].x = attrs.x;
			positions[i].y = attrs.y;
		});
	}

	const components = findComponents(nodes, edges);
	const packNodes: PackNode[] = nodes.map((n, i) => ({
		x: positions[i].x,
		y: positions[i].y,
		radius: n.radius,
		component: components[i],
	}));

	// Spacing runs off the force result; a yield first keeps the last slice
	// from blocking straight into it
	if (shouldStop()) return false;
	await new Promise<void>(resolve => schedule(resolve));
	if (shouldStop()) return false;
	prescale(packNodes);
	resolveOverlaps(packNodes, o.noverlapSweeps);

	packOverlappingComponents(packNodes, COMPONENT_PAD);

	for (let i = 0; i < nodes.length; i++) {
		nodes[i].x = packNodes[i].x;
		nodes[i].y = packNodes[i].y;
	}
	return true;
}
