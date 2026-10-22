# Data Model

## Why a lightweight ontology?

Traditional knowledge graphs often require complex schemas with dozens of entity and relationship types, making them difficult to maintain and query. Simple Graph Builder takes a different approach:

- **10 Fixed Entity Types**: PERSON, ORGANIZATION, CONCEPT, PROJECT, TOOL, EVENT, PLACE, DOCUMENT, METHOD, TOPIC - covering all common knowledge domains
- **Free-form Relationship Verbs**: Express relationships naturally with active verbs like "develops", "uses", "causes", "cites"
- **Detail Property**: Each relationship includes a `detail` field for nuanced descriptions without schema explosion

This design provides **structured entity classification with expressive relationships**, making it easy to build, query, and maintain your personal knowledge graph.

## Entity Types (10 Fixed Types)
The LLM must classify each entity into one of these types:

| Type | Description | Examples |
|------|-------------|----------|
| `PERSON` | People, individuals | Authors, researchers, team members |
| `ORGANIZATION` | Companies, institutions | Google, MIT, research labs |
| `CONCEPT` | Ideas, theories, principles | Machine learning, API design |
| `PROJECT` | Projects, products, initiatives | Obsidian, GraphRAG |
| `TOOL` | Software, hardware, instruments | Python, VS Code, Docker |
| `EVENT` | Meetings, conferences, milestones | NeurIPS 2024, sprint review |
| `PLACE` | Locations, venues, geography | San Francisco, AWS us-east-1 |
| `DOCUMENT` | Papers, books, articles, notes | "Attention Is All You Need" |
| `METHOD` | Techniques, approaches, workflows | Agile, TDD, fine-tuning |
| `TOPIC` | Subjects, themes, fields, domains | NLP, distributed systems |

One further type, `NOTE`, is created by the plugin rather than the LLM. Each
analyzed note becomes a `NOTE` node that `mentions` the entities extracted from
it and `links to` the notes it wikilinks, which is what ties separate notes into
one graph. Turn them off with **Show note nodes** for an entity-only view.

## Relationships (Free-form Verbs)
Relationships are expressed as active verbs describing how entities relate:

| Verb Examples | Meaning |
|--------------|---------|
| `develops`, `creates`, `builds` | Creation, authorship |
| `uses`, `applies`, `implements` | Usage, application |
| `causes`, `leads to`, `enables` | Causality, dependency |
| `contains`, `includes`, `has` | Composition, membership |
| `cites`, `references`, `based on` | Citation, source |
| `relates to`, `similar to` | General association |

Each relationship also includes an optional `detail` field for additional context.

## Entity Resolution

A key insight from recent knowledge graph research is that **entity resolution is critical** for quality knowledge graphs [3]. Without proper deduplication, "AI", "artificial intelligence", and "Artificial Intelligence" appear as separate nodes, fragmenting your knowledge.

Simple Graph Builder uses a hybrid resolution pipeline (opt-in feature):

| Stage | Method | Speed |
|-------|--------|-------|
| 1. Persistent cache | Previously resolved tokens | O(1) |
| 2. Session cache | Same name resolved this session | O(1) |
| 3. Exact name | Hash lookup on canonical name | O(1) |
| 4. Alias match | Hash lookup on stored aliases | O(1) |
| 5. Embedding similarity | Cosine similarity > 0.90 = auto-merge | O(n) |
| 6. LLM verification | Ambiguous matches (0.80-0.90) verified by LLM | API call |
| 7. Create new | No match found | - |

This approach resolves most entities via fast hash lookups, reserving expensive embedding searches and LLM calls for genuinely ambiguous cases.

## Where the data lives

Everything stays in your vault, in the plugin folder
`.obsidian/plugins/simple-graph-builder/`:

| File | What it holds |
|---|---|
| `data.json` | Settings (including API keys) and the graph: entities and their relationships. Note nodes and their `mentions` / `links to` edges are not stored; they are rebuilt from your notes and Obsidian's link index on every load |
| `embeddings.bin` | Entity embeddings, if [entity resolution](SETTINGS.md#entity-resolution-opt-in) is on |
| `graph-layout.json` | Where each node sits in the [graph view](GRAPH_VIEW.md#layout) |
| `med-lit/` | A copy of each [imported med-lit project](MED_LIT_IMPORT.md)'s graph |
| `mcp-bridge.cjs` | The bridge script for Claude Desktop, if [agent access](AGENT_ACCESS.md) is on |

If your vault is in git, keep `data.json` out of it; see
[Privacy](https://github.com/junhewk/simple-graph-builder#privacy).
