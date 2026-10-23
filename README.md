# Simple Graph Builder

[![Downloads](https://img.shields.io/github/downloads/junhewk/simple-graph-builder/manifest.json.svg?label=downloads&color=7c3aed&logo=obsidian&displayAssetName=false)](https://obsidian.md/plugins?id=simple-graph-builder)
[![Release](https://img.shields.io/github/v/release/junhewk/simple-graph-builder?display_name=tag&label=release&color=7c3aed)](https://github.com/junhewk/simple-graph-builder/releases/latest)
[![License: MIT](https://img.shields.io/github/license/junhewk/simple-graph-builder?color=7c3aed)](LICENSE)

This plugin builds a lightweight knowledge graph from users' Obsidian notes using LLM-powered entity extraction with a simple yet expressive ontology model to provide knowledge extraction, exploration, and RAG search. Since Obsidian provides wonderful links between notes, implementing ontology model would meet users' (especially researchers') needs.

![Graph View](https://raw.githubusercontent.com/junhewk/simple-graph-builder/master/docs/graph-view.png)

## What's new in 0.8.1

- **Vault analysis says what it will send.** **Analyze entire vault** first
  counts the new and changed notes, then asks with those numbers before anything
  goes to your provider.
- **Auto-analyze on save is easier to find**, at the top of the Analysis
  settings.
- **A shorter settings page.** On Obsidian 1.13 and later, advanced sections
  open on pages of their own, and rows are one line high.
- A long node inspector no longer covers the search box in the graph view.

## What's new in 0.8.0: explore the graph

The graph view becomes a tool for reading your notes through the graph, not
just a picture of it:

- **Search inside the graph.** Matches light up on the map, and a separate list
  shows what the graph reached *without* matching your words, with the
  relationship that connects each one.
- **Inspector, focus and paths.** Click a node for its relationships, its source
  notes and the trail you took to it. Show one or two hops around it, or the
  shortest connection to another node.
- **Display, forces and clusters.** Adjust node and edge size, color and
  opacity, filter by type, tune the layout's forces, and color or pull
  together clusters found from the graph itself. Every change applies live.
- **A layout that is fast and stays put.** The graph shows at once and settles
  in the background. Positions are remembered, so the map keeps its shape
  between sessions and after each analysis.

See [Graph View](https://github.com/junhewk/simple-graph-builder/blob/master/docs/GRAPH_VIEW.md).
Earlier releases are in the [changelog](https://github.com/junhewk/simple-graph-builder/blob/master/CHANGELOG.md).

## Why a lightweight ontology?

Traditional knowledge graphs often require complex schemas with dozens of entity and relationship types, making them difficult to maintain and query. Simple Graph Builder uses **10 fixed entity types** (PERSON, ORGANIZATION, CONCEPT, PROJECT, TOOL, EVENT, PLACE, DOCUMENT, METHOD, TOPIC), **free-form relationship verbs** ("develops", "uses", "causes", "cites"), and a `detail` on each relationship for nuance without schema explosion. See the [data model](https://github.com/junhewk/simple-graph-builder/blob/master/docs/DATA_MODEL.md).

## Features

- **Entity extraction**: Extract entities and relationships from your notes with an LLM, at a depth you choose. Every request carries a JSON schema and every reply is validated against it, so malformed entities are reported and dropped rather than polluting the graph
- **Hybrid entity resolution** (opt-in): A multi-stage pipeline of fast lookups, embedding similarity and LLM verification merges "AI", "artificial intelligence" and "인공지능" into one entity (inspired by KGGen [3])
- **Notes in the graph**: Each analyzed note becomes a node linked to the entities it mentions and the notes it wikilinks
- **Interactive graph view**: Search the graph in place, inspect and walk its relationships, focus on a neighborhood, find paths, and adjust appearance, forces and clusters live. Fast on graphs of thousands of nodes
- **Advanced search**: Notes and entities ranked by text match plus graph proximity (Personalized PageRank, as in HippoRAG [6]), with an explanation for every result and no API calls
- **Agent access (MCP)**: Let Claude Code, Claude Desktop or Codex search your vault and knowledge graph through a local, token-protected, read-only MCP server
- **med-lit import**: Bring a [med-lit-mcp](https://github.com/junhewk/med-lit-mcp) literature review (articles, wiki pages and its knowledge graph) into your vault, merged into your graph and kept up to date by re-importing
- **Vault write-back** (opt-in): Mirror the graph into your vault as real Obsidian links, so it also appears in Obsidian's graph view, backlinks and properties
- **Multiple LLM providers**: Claude, OpenAI, Gemini, DeepSeek, and local servers (Ollama, or anything OpenAI-compatible such as llama.cpp, LM Studio and vLLM), with reasoning-effort control
- **Analysis exclusions**: Skip files and folders by path or glob, optionally honoring Obsidian's own exclusion list
- **Korean language support**: Syllable-pair matching in both entity resolution and search, so particles ("머신러닝은") and spacing variations still match, with names normalized to Unicode NFC so composed and decomposed Hangul resolve to one entity
- **Note neighborhood panel**: The current note's entities and their connections, in a sidebar

## Installation

### From Obsidian Community Plugins
1. Open Settings → Community plugins
2. Search for "Simple Graph Builder"
3. Click Install, then Enable

### Using BRAT (Recommended for Beta)
1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Community Plugins
2. Open command palette → "BRAT: Add a beta plugin"
3. Enter: `junhewk/simple-graph-builder`
4. Enable the plugin in Settings → Community plugins

### Manual Installation
1. Download `main.js`, `styles.css`, and `manifest.json` from the latest release
2. Create folder: `VaultFolder/.obsidian/plugins/simple-graph-builder/`
3. Copy the downloaded files into the folder
4. Reload Obsidian and enable the plugin

## Quick start

1. Choose a provider and enter its API key in **Settings → Simple Graph Builder** (or point it at a local server)
2. Open a note and run **Analyze current note**, or **Analyze entire vault** from settings
3. Run **Open graph view**, and type in its search box to find your way in

## Commands

| Command | Description |
|---------|-------------|
| `Analyze current note` | Extract entities from the active note |
| `Search graph and notes` | Advanced search over notes and entities (no API calls) |
| `Open graph view` | Show the knowledge graph |
| `Open note neighborhood panel` | Show the current note's connections in the sidebar |
| `Remove current note from graph` | Remove the active note from the graph |
| `Rebuild note layer` | Recreate note nodes and their links from existing data (no API calls) |
| `Write graph links into notes` | Apply the graph to your vault as Obsidian links (no API calls) |
| `Remove graph links from notes` | Take the link property back out of every note |
| `Import or update med-lit project` | Import a med-lit-mcp review into the vault, or update one imported before (no API calls) |
| `Clear all graph data` | Reset the entire graph |

The ribbon icon offers **Analyze current note** and **Open graph view**. The status bar shows node counts by type.

## Documentation

| Guide | Covers |
|---|---|
| [Graph View](https://github.com/junhewk/simple-graph-builder/blob/master/docs/GRAPH_VIEW.md) | Searching, inspecting and arranging the graph; display, forces, clusters and layout |
| [Search](https://github.com/junhewk/simple-graph-builder/blob/master/docs/SEARCH.md) | The search command, and how results are ranked |
| [Settings](https://github.com/junhewk/simple-graph-builder/blob/master/docs/SETTINGS.md) | Providers, analysis, exclusions, entity resolution, vault write-back |
| [Agent Access (MCP)](https://github.com/junhewk/simple-graph-builder/blob/master/docs/AGENT_ACCESS.md) | Connecting Claude Code, Claude Desktop or Codex, the tools they get, and what they can see |
| [Importing med-lit Projects](https://github.com/junhewk/simple-graph-builder/blob/master/docs/MED_LIT_IMPORT.md) | Importing, updating and removing literature reviews |
| [Data Model](https://github.com/junhewk/simple-graph-builder/blob/master/docs/DATA_MODEL.md) | Entity types, relationships, entity resolution, and where data is stored |
| [Changelog](https://github.com/junhewk/simple-graph-builder/blob/master/CHANGELOG.md) | What changed in each release, and what upgrading does |
| [Development](https://github.com/junhewk/simple-graph-builder/blob/master/docs/DEVELOPMENT.md) | Building, testing and releasing |

## Supported models

Note analysis requires a model that can return **structured output**. Models that cannot are refused with a message rather than silently producing a lower-quality graph, and the settings panel flags them as you select them.

| Provider | Models |
|----------|--------|
| Claude | `claude-sonnet-5`, `claude-haiku-4-5` |
| OpenAI | `gpt-6-luna`, `gpt-5.4-mini` |
| Gemini | `gemini-3.6-flash`, `gemini-3.5-flash-lite` |
| DeepSeek | `deepseek-flash` |
| Local | any model your server exposes — Ollama, or an OpenAI-compatible server such as llama.cpp's `llama-server`, LM Studio or vLLM |

Any other model can be typed into the **Custom…** field, for example `deepseek-v4-pro`.

DeepSeek offers JSON mode rather than schema-enforced output, so the plugin
puts the schema in the prompt and still validates every reply against it. At
the default *Minimal* reasoning effort, DeepSeek's thinking is switched off.
At higher levels it stays on, and the output budget is raised to 32k tokens,
because DeepSeek counts thinking against it.

## API costs

Only note analysis calls an API. Search, the graph view and agent access make no API calls.

- **Claude, OpenAI, Gemini, DeepSeek**: Each note analysis costs your provider's pricing
- **Local servers**: Free (runs on your machine)

If [entity resolution](https://github.com/junhewk/simple-graph-builder/blob/master/docs/SETTINGS.md#entity-resolution-opt-in) is on, embeddings add a little:

- **OpenAI**: ~$0.02 per 1M tokens for `text-embedding-3-small`
- **Gemini**: Free tier available for `gemini-embedding-001`
- **Local**: Free (models like `nomic-embed-text`)

## Privacy

- Your notes are sent to the configured LLM provider for entity extraction. Use a local server for fully local processing
- **Analyze entire vault** enumerates markdown file paths only when you start it. It reads eligible notes on your computer to count the new and changed ones, and sends nothing until you confirm those numbers
- Analyzing the current note and auto-analysis read only the individual note being processed
- No data is stored externally; all graph data stays in your vault ([where](https://github.com/junhewk/simple-graph-builder/blob/master/docs/DATA_MODEL.md#where-the-data-lives))
- **Importing a med-lit project** reads its folder on your computer and copies its pages into the vault. It makes no API calls, unless you choose embedding-based matching
- **Agent Access** (off by default) serves your notes to AI agents you connect. They see notes, not your API keys or settings, and never your excluded notes. What an agent does with what it reads (for example, sending it to its own model provider) is governed by that agent

### If you version-control your vault

Obsidian stores plugin settings — **including your API keys** — in
`.obsidian/plugins/simple-graph-builder/data.json`, together with the graph
itself. If your vault is a git repository, add this to your `.gitignore`:

```gitignore
.obsidian/plugins/simple-graph-builder/data.json
```

Pushing that file to a public repository publishes your keys in plaintext, and
deleting it later does not help — git keeps the history. If it has already been
pushed, revoke the key at your provider's console and issue a new one.

## Technical background

This plugin's entity resolution approach is inspired by recent advances in knowledge graph construction:

- **LightRAG** [1] demonstrated lightweight graph-based RAG but lacks entity resolution
- **Microsoft GraphRAG** [2] provides comprehensive extraction but at high cost ($50-100+ per corpus)
- **KGGen** [3] introduced the insight that entity resolution is critical for quality knowledge graphs

Simple Graph Builder combines the simplicity of LightRAG with KGGen's hybrid resolution approach, adapted for Obsidian's local-first architecture. Search follows HippoRAG [6] in ranking by Personalized PageRank over the graph.

### References

[1] Guo, Z., et al. (2024). "LightRAG: Simple and Fast Retrieval-Augmented Generation." https://github.com/HKUDS/LightRAG

[2] Edge, D., et al. (2024). "From Local to Global: A Graph RAG Approach to Query-Focused Summarization." arXiv:2404.16130. https://github.com/microsoft/graphrag

[3] Shu, Y., et al. (2025). "KGGen: Extracting Knowledge Graphs from Plain Text with Language Models." NeurIPS 2025. arXiv:2502.09956. https://github.com/stair-lab/kggen

[4] Neo4j, Inc. (2024). "Neo4j GraphRAG Package for Python." https://neo4j.com/docs/neo4j-graphrag-python/current/

[5] Veen, A. (2024). "pgvector: Open-source vector similarity search for Postgres." https://github.com/pgvector/pgvector

[6] Gutiérrez, B. J., et al. (2024). "HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models." NeurIPS 2024. arXiv:2405.14831. https://github.com/OSU-NLP-Group/HippoRAG

## Support

- [GitHub Issues](https://github.com/junhewk/simple-graph-builder/issues)
- [Documentation](https://github.com/junhewk/simple-graph-builder)

## License

MIT License - see [LICENSE](LICENSE) for details.
