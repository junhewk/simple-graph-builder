/**
 * Fixtures for the layout suites.
 *
 * Not a *.test.ts, so the runner won't execute it directly.
 *
 * Provides a deterministic vault-shaped graph generator (note hubs with entity
 * stars, cluster-shared entities, a few disconnected satellites -- the shape
 * the extraction pipeline actually produces, at the real vault's ~3.3:1
 * edge:node ratio), a headless fCoSE seeding helper, and a frozen copy of the
 * 0.5.1 grid-snap spread that the refinement replaced, kept as the baseline
 * the eval compares against.
 */
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import type { LayoutNode, LayoutEdge } from '../src/graph/layout';

cytoscape.use(fcose);

/** Deterministic PRNG; same seed, same sequence, on any platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Radii mirror the view's label-aware collision radii (80px label budget). */
export const NOTE_RADIUS = 44;
export const ENTITY_RADIUS = 40;

export interface VaultGraphOptions {
  notes: number;
  clusters: number;
  /** Shared entities per cluster; sharing is what creates intra-cluster structure. */
  poolSize: number;
  /** Small disconnected components, as real vaults have. */
  satellites: number;
  seed: number;
}

export interface VaultGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** Ground-truth cluster per node id; -1 for satellite nodes. */
  clusterOf: Map<string, number>;
  noteIds: Set<string>;
}

export function generateVaultGraph(opts: VaultGraphOptions): VaultGraph {
  const rand = mulberry32(opts.seed);
  const nodes: LayoutNode[] = [];
  const clusterOf = new Map<string, number>();
  const noteIds = new Set<string>();
  const edgeKeys = new Set<string>();
  const edges: LayoutEdge[] = [];
  const materialized = new Set<string>();

  const addNode = (id: string, radius: number, cluster: number) => {
    if (materialized.has(id)) return;
    materialized.add(id);
    nodes.push({ id, x: 0, y: 0, radius });
    clusterOf.set(id, cluster);
  };
  const addEdge = (source: string, target: string) => {
    if (source === target) return;
    const key = `${source}|${target}`;
    const rev = `${target}|${source}`;
    if (edgeKeys.has(key) || edgeKeys.has(rev)) return;
    edgeKeys.add(key);
    edges.push({ source, target });
  };

  // Pool entity ids exist per cluster but only become nodes once mentioned
  const pools: string[][] = [];
  for (let c = 0; c < opts.clusters; c++) {
    pools.push(Array.from({ length: opts.poolSize }, (_, i) => `ent:c${c}p${i}`));
  }

  const notesInCluster: string[][] = Array.from({ length: opts.clusters }, () => []);
  let uniqueCounter = 0;

  for (let i = 0; i < opts.notes; i++) {
    const c = i % opts.clusters;
    const noteId = `note:${i}`;
    addNode(noteId, NOTE_RADIUS, c);
    noteIds.add(noteId);

    // Each note links back to 1-2 earlier notes of its cluster: the linear
    // note layer that keeps a cluster connected even without shared entities
    const siblings = notesInCluster[c];
    for (let l = 0; l < Math.min(siblings.length, 1 + Math.floor(rand() * 2)); l++) {
      addEdge(noteId, siblings[Math.floor(rand() * siblings.length)]);
    }
    notesInCluster[c].push(noteId);

    const k = 5 + Math.floor(rand() * 11); // 5..15 entities
    const mentioned: string[] = [];
    for (let e = 0; e < k; e++) {
      const r = rand();
      let id: string;
      let cluster = c;
      if (r < 0.70) {
        id = pools[c][Math.floor(rand() * pools[c].length)];
      } else if (r < 0.95) {
        id = `ent:u${uniqueCounter++}`;
      } else {
        const other = (c + 1 + Math.floor(rand() * (opts.clusters - 1))) % opts.clusters;
        id = pools[other][Math.floor(rand() * pools[other].length)];
        cluster = other;
      }
      addNode(id, ENTITY_RADIUS, cluster);
      if (!mentioned.includes(id)) mentioned.push(id);
      addEdge(noteId, id);
    }

    // Entity-entity relationships among co-mentioned entities; this is what
    // lifts the ratio from star-graph 1:1 toward the real vault's 3.3:1
    const relations = Math.floor(mentioned.length * 0.8);
    for (let p = 0; p < relations; p++) {
      const a = mentioned[Math.floor(rand() * mentioned.length)];
      const b = mentioned[Math.floor(rand() * mentioned.length)];
      addEdge(a, b);
    }
  }

  // Disconnected satellites: one small hub with a short chain hanging off it
  for (let s = 0; s < opts.satellites; s++) {
    const size = 6 + Math.floor(rand() * 7);
    const hub = `sat:${s}h`;
    addNode(hub, NOTE_RADIUS, -1);
    let prev = hub;
    for (let m = 0; m < size; m++) {
      const id = `sat:${s}m${m}`;
      addNode(id, ENTITY_RADIUS, -1);
      addEdge(m % 2 === 0 ? hub : prev, id);
      prev = id;
    }
  }

  return { nodes, edges, clusterOf, noteIds };
}

/** ~1300 nodes / ~4300 edges: fast enough for every `npm test` run. */
export const FAST_PRESET: VaultGraphOptions = { notes: 250, clusters: 8, poolSize: 55, satellites: 3, seed: 42 };

/** Sized to the reporting user's real vault: ≈2263 nodes / ≈7448 edges. */
export const REAL_VAULT_PRESET: VaultGraphOptions = { notes: 430, clusters: 12, poolSize: 60, satellites: 4, seed: 7 };

/**
 * Position nodes with headless fCoSE, as the view's first stage does.
 * Writes positions into the given nodes.
 */
export async function fcoseSeed(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  quality: 'draft' | 'default'
): Promise<number> {
  const elements = [
    ...nodes.map(n => ({ data: { id: n.id } })),
    ...edges.map((e, i) => ({ data: { id: `e${i}`, source: e.source, target: e.target } })),
  ];
  const cy = cytoscape({
    headless: true,
    styleEnabled: true,
    elements,
    style: [{ selector: 'node', style: { width: 12, height: 12 } }],
  });
  const t0 = performance.now();
  const layout = cy.layout({
    name: 'fcose',
    quality,
    animate: false,
    randomize: true,
    tile: true,
  } as never);
  const settled = layout.promiseOn('layoutstop');
  layout.run();
  await settled;
  for (const n of nodes) {
    const p = cy.getElementById(n.id).position();
    n.x = p.x;
    n.y = p.y;
  }
  cy.destroy();
  return performance.now() - t0;
}

const NODE_SPACING = 60;

function buildSpiral(maxRadius: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  for (let r = 1; r <= maxRadius; r++) {
    for (let d = -r; d <= r; d++) {
      offsets.push([d, -r], [d, r]);
    }
    for (let d = -r + 1; d <= r - 1; d++) {
      offsets.push([-r, d], [r, d]);
    }
  }
  return offsets;
}

/**
 * Frozen copy of the 0.5.1 spreadDraftLayout algorithm (scale to one 60px
 * cell per node, snap stacked nodes to the nearest free cell). Deleted from
 * src/ when refineLayout replaced it; kept here as the eval baseline.
 */
export function gridSnapSpread(nodes: LayoutNode[]): void {
  const count = nodes.length;
  if (count < 2) return;

  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of nodes) {
    x1 = Math.min(x1, n.x);
    y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x);
    y2 = Math.max(y2, n.y);
  }
  const extent = Math.max(x2 - x1, y2 - y1);
  if (extent <= 0) return;

  const scale = (Math.sqrt(count) * NODE_SPACING) / extent;
  if (scale > 1) {
    for (const n of nodes) {
      n.x *= scale;
      n.y *= scale;
    }
  }

  const spiral = buildSpiral(Math.ceil(Math.sqrt(count)) + 2);
  const taken = new Set<string>();
  for (const n of nodes) {
    const cx = Math.round(n.x / NODE_SPACING);
    const cy = Math.round(n.y / NODE_SPACING);
    if (!taken.has(`${cx},${cy}`)) {
      taken.add(`${cx},${cy}`);
      continue;
    }
    for (const [dx, dy] of spiral) {
      const key = `${cx + dx},${cy + dy}`;
      if (taken.has(key)) continue;
      taken.add(key);
      n.x = (cx + dx) * NODE_SPACING;
      n.y = (cy + dy) * NODE_SPACING;
      break;
    }
  }
}

export function cloneNodes(nodes: LayoutNode[]): LayoutNode[] {
  return nodes.map(n => ({ ...n }));
}
