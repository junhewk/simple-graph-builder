/**
 * The note layer must stay linear.
 *
 * THE BUG: mergeInternalLinksIntoCache connected every entity in a note to
 * every entity in each linked note -- O(L*k^2) edges where one edge per note
 * pair was intended. A real 141-note vault ended up with 188,097 junk edges out
 * of 191,436 (98.3%), a 115 MB data.json, and a graph too dense to read.
 *
 * These checks are sized so a reintroduced cross product fails loudly rather
 * than merely getting slower.
 */
import { fakePlugin } from './graph-harness';
import { GraphCache } from '../src/graph/cache';
import { mergeNoteLayerIntoCache, rebuildNoteLayer, generateNoteNodeId } from '../src/graph/merge';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const NOTES = ['a.md', 'b.md', 'c.md'];
const ENTITIES_PER_NOTE = 20;

// Every note links to both others, so the old code would have produced
// 3 notes * 2 links * 20 * 20 = 2400 edges.
const OLD_CROSS_PRODUCT = NOTES.length * (NOTES.length - 1) * ENTITIES_PER_NOTE * ENTITIES_PER_NOTE;
const EXPECTED_MENTIONS = NOTES.length * ENTITIES_PER_NOTE;          // 60
const EXPECTED_LINKS = NOTES.length * (NOTES.length - 1);            // 6

// Resolves [[b]] -> b.md, as Obsidian's metadataCache would
const app = {
  metadataCache: {
    getFirstLinkpathDest: (target: string) => {
      const path = `${target}.md`;
      return NOTES.includes(path) ? { path } : null;
    },
    resolvedLinks: Object.fromEntries(
      NOTES.map(p => [p, Object.fromEntries(NOTES.filter(q => q !== p).map(q => [q, 1]))])
    ),
  },
} as never;

const contentFor = (path: string) =>
  NOTES.filter(p => p !== path).map(p => `[[${p.replace('.md', '')}]]`).join(' ');

async function seeded() {
  const cache = new GraphCache(fakePlugin().plugin);
  await cache.ensureLoaded();
  for (const path of NOTES) {
    for (let i = 0; i < ENTITIES_PER_NOTE; i++) {
      cache.addNode({
        id: `concept:${path}-e${i}`,
        entityType: 'CONCEPT',
        properties: { name: `${path} entity ${i}` },
        sourceNotes: [path],
      });
    }
  }
  return cache;
}

async function main() {
  // --- the regression itself ---
  const cache = await seeded();
  for (const path of NOTES) {
    mergeNoteLayerIntoCache(cache, app, { path } as never, contentFor(path));
  }

  const edges = cache.getAllEdges();
  const mentions = edges.filter(e => e.relationship === 'mentions');
  const links = edges.filter(e => e.relationship === 'links to');
  const noteNodes = cache.getAllNodes().filter(n => n.entityType === 'NOTE');

  check('one NOTE node per analyzed note', noteNodes.length === NOTES.length, String(noteNodes.length));
  check(`${EXPECTED_MENTIONS} mentions edges (one per entity)`, mentions.length === EXPECTED_MENTIONS, String(mentions.length));
  check(`${EXPECTED_LINKS} links-to edges (one per note pair)`, links.length === EXPECTED_LINKS, String(links.length));
  check(`NOT the ${OLD_CROSS_PRODUCT}-edge cross product`, edges.length < OLD_CROSS_PRODUCT / 10, `${edges.length} edges`);
  check('edge count stays linear in nodes', edges.length < cache.getAllNodes().length * 2, String(edges.length));

  // Every links-to edge joins two NOTE nodes -- the old pass joined entities
  const noteIds = new Set(noteNodes.map(n => n.id));
  check('links-to edges only join notes', links.every(e => noteIds.has(e.source) && noteIds.has(e.target)));
  check('no self-referential note edge', links.every(e => e.source !== e.target));
  check('mentions edges go note -> entity', mentions.every(e => noteIds.has(e.source) && !noteIds.has(e.target)));
  check('no legacy wikilink marker is written', edges.every(e => e.properties?.detail !== 'wikilink'));

  // --- idempotence: re-analysis must not accumulate ---
  const before = cache.getAllEdges().length;
  for (const path of NOTES) {
    mergeNoteLayerIntoCache(cache, app, { path } as never, contentFor(path));
  }
  check('re-running adds nothing', cache.getAllEdges().length === before, `${before} -> ${cache.getAllEdges().length}`);

  // --- rebuildNoteLayer reaches the same state without file contents ---
  const rebuilt = await seeded();
  const stats = rebuildNoteLayer(rebuilt, app);
  check('rebuild creates the same note nodes', stats.noteNodesAdded === NOTES.length, String(stats.noteNodesAdded));
  check('rebuild creates the same edges', rebuilt.getAllEdges().length === EXPECTED_MENTIONS + EXPECTED_LINKS,
    String(rebuilt.getAllEdges().length));
  check('rebuild is idempotent', (() => {
    const n = rebuilt.getAllEdges().length;
    rebuildNoteLayer(rebuilt, app);
    return rebuilt.getAllEdges().length === n;
  })());
  check('note node ids are path-based', !!rebuilt.getNodeById(generateNoteNodeId('a.md')));

  // A note whose links point at unanalyzed notes gets a node and mentions, but
  // no dangling links -- matching the old behaviour of skipping unknown targets.
  const lonely = new GraphCache(fakePlugin().plugin);
  await lonely.ensureLoaded();
  lonely.addNode({ id: 'concept:x', entityType: 'CONCEPT', properties: { name: 'X' }, sourceNotes: ['solo.md'] });
  mergeNoteLayerIntoCache(lonely, app, { path: 'solo.md' } as never, '[[nowhere]]');
  check('unanalyzed link targets are skipped',
    lonely.getAllEdges().filter(e => e.relationship === 'links to').length === 0);
  check('but the note itself is still added', lonely.getAllEdges().length === 1);

  console.log(fail === 0 ? 'notelayer: all checks passed' : `${fail} FAILURES`);
  process.exit(fail ? 1 : 0);
}

void main();
