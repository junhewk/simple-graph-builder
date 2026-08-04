/**
 * Layout quality metrics for the layout suites.
 *
 * Not a *.test.ts, so the runner won't execute it directly.
 *
 * Everything neighbourhood-shaped runs on a spatial hash grid, so the metrics
 * stay near O(n) and the suite can afford real vault sizes.
 */
import type { LayoutNode, LayoutEdge } from '../src/graph/layout';

class SpatialGrid {
  private cells = new Map<string, LayoutNode[]>();
  constructor(nodes: LayoutNode[], private cell: number) {
    for (const n of nodes) {
      const key = this.keyFor(n.x, n.y);
      const bucket = this.cells.get(key);
      if (bucket) bucket.push(n);
      else this.cells.set(key, [n]);
    }
  }
  private keyFor(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  /** All nodes in cells within `rings` cells of the node's cell. */
  ring(n: LayoutNode, rings: number): LayoutNode[] {
    const cx = Math.floor(n.x / this.cell);
    const cy = Math.floor(n.y / this.cell);
    const found: LayoutNode[] = [];
    for (let dx = -rings; dx <= rings; dx++) {
      for (let dy = -rings; dy <= rings; dy++) {
        const bucket = this.cells.get(`${cx + dx},${cy + dy}`);
        if (bucket) found.push(...bucket);
      }
    }
    return found;
  }
}

const dist = (a: LayoutNode, b: LayoutNode) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Fraction of nodes whose nearest neighbour is at least `threshold` away --
 * i.e. nodes that are individually visible rather than part of a stack.
 */
export function visibility(nodes: LayoutNode[], threshold: number): number {
  if (nodes.length < 2) return 1;
  const grid = new SpatialGrid(nodes, threshold);
  let visible = 0;
  for (const n of nodes) {
    // A cell equals the threshold, so anything closer than the threshold is
    // within one ring of cells.
    const near = grid.ring(n, 1);
    let ok = true;
    for (const m of near) {
      if (m !== n && dist(n, m) < threshold) {
        ok = false;
        break;
      }
    }
    if (ok) visible++;
  }
  return visible / nodes.length;
}

/**
 * Median distance from a node to its nearest neighbour: the layout's typical
 * node spacing. Used to normalize length metrics, so they measure shape
 * rather than scale (the view fits the graph to the viewport, so absolute
 * size is invisible to the user).
 */
export function medianNodeSpacing(nodes: LayoutNode[], probe = 400): number {
  if (nodes.length < 2) return 1;
  const grid = new SpatialGrid(nodes, probe);
  const nearest: number[] = [];
  for (const n of nodes) {
    let best = Infinity;
    for (const m of grid.ring(n, 1)) {
      if (m === n) continue;
      const d = dist(n, m);
      if (d < best) best = d;
    }
    if (best < Infinity) nearest.push(best);
  }
  if (nearest.length === 0) return 1;
  nearest.sort((a, b) => a - b);
  return nearest[Math.floor(nearest.length / 2)] || 1;
}

/**
 * Edge lengths relative to `ideal`. Pass medianNodeSpacing() as the ideal to
 * get a scale-invariant reading of "are connected nodes near each other,
 * measured in units of how far apart nodes sit in general".
 */
export function edgeLengthStats(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  ideal: number
): { mean: number; p95: number } {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const ratios: number[] = [];
  for (const e of edges) {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    if (a && b) ratios.push(dist(a, b) / ideal);
  }
  if (ratios.length === 0) return { mean: 0, p95: 0 };
  ratios.sort((x, y) => x - y);
  const mean = ratios.reduce((s, r) => s + r, 0) / ratios.length;
  const p95 = ratios[Math.min(ratios.length - 1, Math.floor(ratios.length * 0.95))];
  return { mean, p95 };
}

/**
 * How much of each node's spatial surroundings is its actual graph
 * neighbourhood: for every node with degree >= 1, the fraction of its
 * min(k, degree) nearest nodes on screen that are 1-hop graph neighbours,
 * averaged. A lattice scores near zero; a good force layout puts adjacent
 * nodes next to each other.
 */
export function neighborhoodPreservation(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  k = 10,
  cell = 60
): number {
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    let set = adjacency.get(a);
    if (!set) adjacency.set(a, set = new Set());
    set.add(b);
  };
  for (const e of edges) {
    link(e.source, e.target);
    link(e.target, e.source);
  }

  const grid = new SpatialGrid(nodes, cell);
  let sum = 0;
  let counted = 0;
  for (const n of nodes) {
    const neighbors = adjacency.get(n.id);
    if (!neighbors || neighbors.size === 0) continue;
    const want = Math.min(k, neighbors.size);

    // Expand rings until we have at least k candidates plus a safety ring, so
    // the true k nearest cannot hide in an unvisited cell
    let rings = 1;
    let candidates = grid.ring(n, rings);
    while (candidates.length < want + 1 && rings < 50) {
      rings++;
      candidates = grid.ring(n, rings);
    }
    candidates = grid.ring(n, rings + 1);

    const nearest = candidates
      .filter(m => m !== n)
      .map(m => ({ id: m.id, d: dist(n, m) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, want);
    if (nearest.length === 0) continue;

    const hits = nearest.filter(m => neighbors.has(m.id)).length;
    sum += hits / nearest.length;
    counted++;
  }
  return counted === 0 ? 0 : sum / counted;
}

/**
 * Mean intra-cluster over mean inter-cluster pairwise distance, sampled.
 * Lower is better; 1.0 means cluster labels are spatially meaningless (as in
 * a grid), well below 1 means clusters occupy distinct regions.
 */
export function clusterSeparation(
  nodes: LayoutNode[],
  clusterOf: Map<string, number>,
  rand: () => number,
  samples = 20000
): number {
  const clustered = nodes.filter(n => (clusterOf.get(n.id) ?? -1) >= 0);
  if (clustered.length < 2) return 1;

  let intraSum = 0, intraCount = 0, interSum = 0, interCount = 0;
  for (let s = 0; s < samples; s++) {
    const a = clustered[Math.floor(rand() * clustered.length)];
    const b = clustered[Math.floor(rand() * clustered.length)];
    if (a === b) continue;
    const d = dist(a, b);
    if (clusterOf.get(a.id) === clusterOf.get(b.id)) {
      intraSum += d;
      intraCount++;
    } else {
      interSum += d;
      interCount++;
    }
  }
  if (intraCount === 0 || interCount === 0) return 1;
  return (intraSum / intraCount) / (interSum / interCount);
}

/** Whether any two components' padded bounding boxes intersect. */
export function componentBoxesOverlap(
  nodes: LayoutNode[],
  componentOf: number[],
  pad: number
): boolean {
  interface Box { x1: number; y1: number; x2: number; y2: number }
  const boxes = new Map<number, Box>();
  nodes.forEach((n, i) => {
    const box = boxes.get(componentOf[i]);
    if (box) {
      box.x1 = Math.min(box.x1, n.x - n.radius);
      box.y1 = Math.min(box.y1, n.y - n.radius);
      box.x2 = Math.max(box.x2, n.x + n.radius);
      box.y2 = Math.max(box.y2, n.y + n.radius);
    } else {
      boxes.set(componentOf[i], { x1: n.x - n.radius, y1: n.y - n.radius, x2: n.x + n.radius, y2: n.y + n.radius });
    }
  });
  const list = [...boxes.values()].map(b => ({ x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad }));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2) return true;
    }
  }
  return false;
}
