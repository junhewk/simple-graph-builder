# Development

```bash
npm install
npm run dev     # watch build
npm run build   # production build (typecheck + bundle)
npm test        # wire-level and engine tests
npm test -- gemini   # run one suite
npm run lint    # includes the type-aware checks the Obsidian review bot runs
npm run eval    # live end-to-end check against the real provider APIs
```

`npm test` bundles each `tests/*.test.ts` with esbuild, stubbing Obsidian's `requestUrl` so outgoing requests can be captured, then asserts the exact JSON each provider adapter builds. No test framework is involved — esbuild is already a dev dependency, and the plugin ships its whole bundle.

These are deliberately wire-level, because that is where the bugs are: a parameter a model rejects, a tool result dropped from a loop, embeddings written at the wrong vector width. Each suite exits non-zero on failure, and the release workflow runs them before publishing.

`tests/layout.test.ts` is the exception: it scores the graph layout (the ForceAtlas2 and spacing passes the view runs) instead of asserting a payload. It generates a vault-shaped graph, lays it out headlessly, and measures how many nodes are individually visible, how many have room for their label, how long edges are relative to typical node spacing, and how well clusters separate — against thresholds and against the layout the previous release shipped. To see the numbers at real-vault scale, bundle it and run it directly:

```bash
npx esbuild tests/layout.test.ts --bundle --platform=node --outfile=/tmp/layout.cjs
SGB_LAYOUT_BENCH=1 node /tmp/layout.cjs
```

`tests/query.test.ts` and the `tests/mcp-*.test.ts` suites cover search and agent access against an in-memory vault that includes an excluded folder. `mcp-http` starts a real server on a free port, checks every rejection path (token, Host/Origin, method, content type, size), and drives the Claude Desktop bridge as a child process. `tests/query-reached.test.ts` covers the graph view's [reached-through-the-graph](SEARCH.md#reached-through-the-graph) results on a graph where text matches outnumber the result limit, including that a hub every node touches is ranked below specific neighbors.

The graph view's own logic is tested where it can run under node:

- `tests/graph-display.test.ts`: display settings (defaults, clamping, malformed values), color conversion, cluster detection, and that the edge weights behind **Link length** and **Cluster pull** really change how long ForceAtlas2 settles an edge.
- `tests/positions.test.ts`: the remembered-positions file, and where new nodes are placed around a remembered layout.

The live layout itself (`src/graph/live-layout.ts`) needs a browser `Worker`, so no suite runs it. Check it in Obsidian: open a large vault's graph with `graph-layout.json` deleted and watch it settle, then reopen it and confirm nothing moves.

`npm run eval` is the opposite end: it bundles `tests/*.eval.ts` against a stub whose `requestUrl` performs real HTTP, then runs the full extraction pipeline against every provider you have a key for in the environment. Providers without a key are skipped, so it is safe to run with just one.

```bash
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... DEEPSEEK_API_KEY=... npm run eval
```

## Before a release

The literature suites (`npm test -- literature`) exercise Boolean grouping,
provider wire requests, PubMed XML parsing, OpenAlex abstract reconstruction,
identifier matching, conflicting provenance, paging, retries, partial failures,
stale responses, cache bounds and the external URL action. Synthetic API examples
live in `tests/fixtures/literature`. The XML DOM implementation is a development
dependency only; production uses the platform's inert `DOMParser`.

`npm run eval -- literature` is a separate live PubMed/OpenAlex smoke test. It
does not call a model or write a vault. Optional environment variables are
`SGB_LITERATURE_EMAIL`, `SGB_PUBMED_API_KEY` and `SGB_OPENALEX_API_KEY`.

For the literature UI acceptance check, build and run
`node scripts/make-literature-test-vault.mjs /tmp/sgb-literature-acceptance`.
The target must be new or empty. Follow `Start.md` in the generated vault and
compare note bytes, persisted graph records, hashes and import metadata after
startup settles versus after searching and opening a publication. Obsidian can
update its workspace state and the graph can save layout positions separately;
neither is literature note/graph mutation. Check ordinary graphs and the
existing imported-graph fixture, empty results, one failing source, missing
abstracts and a second search started before the first finishes.

Run `npm test`, `npm run build` and `npm run lint` before releasing. The release
metadata must agree across `package.json`, `manifest.json`, `versions.json` and
the first changelog section. Every pushed tag publishes through the workflow.

The 0.10.0 acceptance run on November 11, 2026 passed all 47 suites, production
build and lint, and live PubMed/OpenAlex retrieval without keys. In Obsidian
1.15.0 on macOS, both inspector traversal and the two-step path action retained
`Simulation —provides→ Feedback ←uses— Deliberate practice`. An edited query
returned 20 records per source; an outside-vault publication displayed both
abstract versions and opened its PMC page in the system browser. Before/after
hashes and data comparisons confirmed all four fixture notes, persisted graph,
hashes, imports, resolution cache and embedding metadata were unchanged. Mobile
and other desktop platforms still need their own native acceptance run.

`docs/TESTING-0.6.0.md` is the step-by-step check written for 0.6.0, the first
release that wrote into notes. It uses a generated test vault:

```bash
npm run build
node scripts/make-test-vault.mjs ~/sgb-test-vault           # 120 notes, 520 entities
node scripts/make-test-vault.mjs ~/sgb-large 400 1600       # ~2,000 nodes, for graph view speed
cp main.js manifest.json styles.css ~/sgb-test-vault/.obsidian/plugins/simple-graph-builder/
```

Pushing a tag runs the release workflow, which publishes to every user. Push a
tag only after the checks pass.
