/**
 * The large-graph layout must apply real repulsion.
 *
 * THE BUG: above 1000 nodes the view used fCoSE 'draft' (spectral placement
 * only -- structurally equivalent nodes land on identical coordinates) and
 * then grid-snapped the stacks apart. Every node became visible, but the
 * result was a uniform lattice: no cluster separation, edges criss-crossing
 * the whole frame, nothing like a force-directed layout. A user's real
 * 2263-node vault rendered as a solid block.
 *
 * These checks compare refineLayout (the d3-force refinement that replaced
 * the grid snap) against a frozen copy of that grid snap, from the same
 * spectral seed. The comparative assertions carry the claim "the fix beats
 * the status quo"; the absolute ones pin what the refinement guarantees by
 * construction (separation, bounded edge lengths, packed components).
 *
 * Bench mode prints a metrics table at real-vault scale. The runner only
 * shows a suite's last stdout line, so invoke it directly:
 *
 *   npx esbuild tests/layout.test.ts --bundle --platform=node \
 *     --outfile=/tmp/layout-bench.cjs && SGB_LAYOUT_BENCH=1 node /tmp/layout-bench.cjs
 */
import { refineLayout, findComponents, spacingForNodeCount, LayoutNode, LayoutEdge } from '../src/graph/layout';
import {
  generateVaultGraph,
  fcoseSeed,
  gridSnapSpread,
  cloneNodes,
  mulberry32,
  FAST_PRESET,
  REAL_VAULT_PRESET,
  VaultGraph,
} from './layout-fixtures';
import {
  visibility,
  edgeLengthStats,
  medianNodeSpacing,
  neighborhoodPreservation,
  clusterSeparation,
  componentBoxesOverlap,
  overviewNodePixels,
} from './layout-metrics';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

// The separation the spacing pass guarantees for a graph of this size, less a
// hair of float slack. On a small graph this is the full 80px label budget; on
// a large one it shrinks so the overview stays legible (spacingForNodeCount).
const targetSpacing = (nodeCount: number) => spacingForNodeCount(nodeCount) - 2;
// Node-level visibility: comfortably under the spacing target, so this fails
// only when nodes are genuinely stacked rather than merely close
const visibilityThreshold = (nodeCount: number) => spacingForNodeCount(nodeCount) * 0.6;

interface Variant {
  name: string;
  nodes: LayoutNode[];
  ms: number;
}

interface Metrics {
  visibility: number;
  labelRoom: number;
  edgeMean: number;
  edgeP95: number;
  np: number;
  separation: number;
  overlap: boolean;
  ms: number;
}

function measure(v: Variant, graph: VaultGraph, components: number[]): Metrics {
  // Normalized by the layout's own node spacing, so the reading is about
  // shape rather than scale
  const stats = edgeLengthStats(v.nodes, graph.edges, medianNodeSpacing(v.nodes));
  return {
    visibility: visibility(v.nodes, visibilityThreshold(v.nodes.length)),
    labelRoom: visibility(v.nodes, targetSpacing(v.nodes.length)),
    edgeMean: stats.mean,
    edgeP95: stats.p95,
    np: neighborhoodPreservation(v.nodes, graph.edges),
    separation: clusterSeparation(v.nodes, graph.clusterOf, mulberry32(1234)),
    overlap: componentBoxesOverlap(v.nodes, components, targetSpacing(v.nodes.length)),
    ms: v.ms,
  };
}

function printTable(rows: Array<{ name: string } & Metrics>): void {
  const fmt = (x: number, digits = 2) => x.toFixed(digits);
  console.log(
    'variant'.padEnd(14),
    'visible'.padStart(8),
    'label-room'.padStart(11),
    'edge-mean'.padStart(10),
    'edge-p95'.padStart(9),
    'NP(10)'.padStart(7),
    'cluster-sep'.padStart(12),
    'overlap'.padStart(8),
    'ms'.padStart(7)
  );
  for (const r of rows) {
    console.log(
      r.name.padEnd(14),
      fmt(r.visibility * 100, 1).padStart(7) + '%',
      fmt(r.labelRoom * 100, 1).padStart(10) + '%',
      fmt(r.edgeMean).padStart(10),
      fmt(r.edgeP95).padStart(9),
      fmt(r.np).padStart(7),
      fmt(r.separation).padStart(12),
      String(r.overlap).padStart(8),
      fmt(r.ms, 0).padStart(7)
    );
  }
}

async function runVariants(graph: VaultGraph): Promise<{ seedMs: number; rows: Array<{ name: string } & Metrics>; refined: LayoutNode[]; seed: LayoutNode[] }> {
  const components = findComponents(graph.nodes, graph.edges);
  const seedMs = await fcoseSeed(graph.nodes, graph.edges, 'draft');
  const seed = cloneNodes(graph.nodes);

  const snapNodes = cloneNodes(seed);
  let t0 = performance.now();
  gridSnapSpread(snapNodes);
  const snap: Variant = { name: 'grid-snap', nodes: snapNodes, ms: performance.now() - t0 };

  const refinedNodes = cloneNodes(seed);
  t0 = performance.now();
  await refineLayout(refinedNodes, graph.edges, { schedule: cb => cb() });
  const refined: Variant = { name: 'refined', nodes: refinedNodes, ms: performance.now() - t0 };

  const rows = [snap, refined].map(v => ({ name: v.name, ...measure(v, graph, components) }));
  return { seedMs, rows, refined: refinedNodes, seed };
}

async function main() {
  const graph = generateVaultGraph(FAST_PRESET);
  console.log(`fast graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges (ratio ${(graph.edges.length / graph.nodes.length).toFixed(2)})`);

  const { seedMs, rows, refined, seed } = await runVariants(graph);
  const [snap, fine] = rows;
  printTable(rows);
  console.log(`seed (fcose draft): ${seedMs.toFixed(0)}ms`);

  // What the pipeline guarantees by construction
  check('refined: >=97% of nodes individually visible', fine.visibility >= 0.97, `${(fine.visibility * 100).toFixed(1)}%`);
  check('refined: >=95% of nodes keep the spacing target', fine.labelRoom >= 0.95,
    `${(fine.labelRoom * 100).toFixed(1)}% at >=${targetSpacing(graph.nodes.length).toFixed(0)}px`);
  check('refined: disconnected components do not overlap', !fine.overlap);
  check('refined: finishes within 3s at fast-preset size', fine.ms <= 3000, `${fine.ms.toFixed(0)}ms`);

  // Overview legibility. A layout is fitted to the pane, so its extent decides
  // how big a node lands on screen; below about a pixel the graph reads as an
  // empty pane, which is exactly what a user hit on a 5177-node vault laid out
  // 21000px wide. Measured against a 1000px pane and the 12px node the
  // stylesheet draws.
  const nodePx = overviewNodePixels(refined, 1000, 12);
  check('refined: nodes still render above a pixel when fitted', nodePx >= 1,
    `${nodePx.toFixed(2)}px in a 1000px pane`);

  // The fix must beat the grid snap, which is what it replaced. Lengths are
  // normalized by each layout's own node spacing, so these compare shape and
  // not scale. NP(10) stays informational in the table because it does not
  // rank quality at this density (the full-fcose reference scores *below* the
  // grid snap).
  check('refined: edges shorter than grid-snap, relative to node spacing', fine.edgeMean <= 0.85 * snap.edgeMean, `${fine.edgeMean.toFixed(2)} vs ${snap.edgeMean.toFixed(2)}`);
  check('refined: cluster separation beats grid-snap by >=25%', fine.separation <= 0.75 * snap.separation, `${fine.separation.toFixed(2)} vs ${snap.separation.toFixed(2)}`);
  check('refined: clusters occupy distinct regions (sep <= 0.5)', fine.separation <= 0.5, fine.separation.toFixed(2));

  // Spacing-only mode (structureTicks 0) is what medium graphs use: full
  // fCoSE already did the force work, so this must open the layout up for
  // labels *without* rearranging it. Cluster separation is the guard --
  // relaxation without the prescale step degraded it from 0.42 to 0.60.
  const spaced = cloneNodes(seed);
  await refineLayout(spaced, graph.edges, { structureTicks: 0, schedule: cb => cb() });
  const spacedRoom = visibility(spaced, targetSpacing(spaced.length));
  const seedSep = clusterSeparation(seed, graph.clusterOf, mulberry32(1234));
  const spacedSep = clusterSeparation(spaced, graph.clusterOf, mulberry32(1234));
  check('spacing-only: >=95% of nodes keep the spacing target', spacedRoom >= 0.95, `${(spacedRoom * 100).toFixed(1)}%`);
  check('spacing-only: preserves the seed cluster structure', spacedSep <= seedSep * 1.15 + 0.02, `${spacedSep.toFixed(2)} vs seed ${seedSep.toFixed(2)}`);

  // Same seed in, same layout out
  const again = cloneNodes(seed);
  await refineLayout(again, graph.edges, { schedule: cb => cb() });
  const identical = again.every((n, i) => n.x === refined[i].x && n.y === refined[i].y);
  check('refined: deterministic for a given seed', identical);

  // Cancellation leaves the promise resolved false, not hung
  const cancelled = cloneNodes(seed);
  const completed = await refineLayout(cancelled, graph.edges, { schedule: cb => cb(), shouldStop: () => true });
  check('refined: shouldStop cancels', completed === false);

  if (process.env.SGB_LAYOUT_BENCH) {
    console.log('\n--- bench: real vault preset ---');
    const real = generateVaultGraph(REAL_VAULT_PRESET);
    console.log(`real-scale graph: ${real.nodes.length} nodes, ${real.edges.length} edges (ratio ${(real.edges.length / real.nodes.length).toFixed(2)})`);
    const bench = await runVariants(real);
    printTable(bench.rows);
    console.log(`seed (fcose draft): ${bench.seedMs.toFixed(0)}ms`);

    console.log('\n--- bench: full-fcose reference (800 nodes) ---');
    const small = generateVaultGraph({ notes: 150, clusters: 8, poolSize: 40, satellites: 3, seed: 11 });
    const comp = findComponents(small.nodes, small.edges);
    const ms = await fcoseSeed(small.nodes, small.edges, 'default');
    console.log(`reference graph: ${small.nodes.length} nodes, ${small.edges.length} edges`);
    printTable([{ name: 'fcose-full', ...measure({ name: 'fcose-full', nodes: small.nodes, ms }, small, comp) }]);
  }

  console.log(fail === 0 ? 'layout: all checks passed' : `${fail} FAILURES`);
  process.exit(fail ? 1 : 0);
}

void main();
