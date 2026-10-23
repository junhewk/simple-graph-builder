# Changelog

## Unreleased

- **Build the graph with your agent's model, no API key needed.** With the new
  **Let agents add to the graph** setting (under Agent access, off by default),
  an agent such as Claude Code, Claude Desktop or Codex can analyze your notes
  itself: it lists the notes waiting for analysis, reads each one with the same
  rules the plugin gives its providers, and submits what it found. Results are
  checked like a provider's, stale ones are refused, and excluded notes stay
  out of reach. See [Building the graph with an agent](docs/AGENT_ACCESS.md#building-the-graph-with-an-agent).
- **What's new, once per feature update.** After an update like this one, the
  plugin shows these notes once. Fix releases are not announced, and a fresh
  install shows nothing. Turn it off with **Show what's new after updates**,
  under Support in settings.

## 0.8.1: analysis you can size up first

- **Vault analysis says what it will send.** **Start analysis** first counts the
  new and changed notes on your computer, then asks with those numbers, and the
  unchanged, too-short and excluded notes it will skip. Nothing is sent before
  you confirm, progress counts only the notes being sent, and when everything
  is up to date it says so instead of asking.
- **Auto-analyze on save is easier to find.** It now heads the **Analysis**
  section, next to **Analyze entire vault**.
- **A shorter settings page.** On Obsidian 1.13 and later, excluded files, agent
  access, vault write-back, entity resolution and imported projects each open
  on a page of their own, with their state (on or off, or a count) shown on the
  row, as Obsidian's own settings do. Rows are shorter too: descriptions fit on
  one line, the custom model ID box appears only once you choose *Custom…*, and
  graph statistics no longer add a blank paragraph.
- **A long node inspector no longer covers the search box** in the graph view;
  the inspector scrolls instead.

## 0.8.0: explore the graph

**Explore the graph, not just look at it.** The graph view becomes a working
tool for reading your notes through the graph:

- **Search inside the graph.** Matches light up on the map, and a separate list
  shows what the graph reached without matching your words, with the
  relationship that connects each one. Text matches no longer crowd those out.
- **Inspector.** Click a node for its description, every relationship (each one
  a link onward), the notes it came from, and the trail of nodes you visited.
- **Focus and paths.** Show only one or two hops around a node, or the shortest
  connection between two nodes.
- **Display and forces panel.** Node and edge size, color and opacity per type,
  relationship labels, filters, and the layout's forces, all applied live.
- **Clusters.** Groups detected from the graph itself, which you can color,
  list, highlight and pull together in the layout.
- **A faster layout that stays put.** The graph shows at once and settles in a
  background worker, instead of after a frozen wait: about 2 seconds to first
  view on a 2,000-node graph, against 5.4 before. Positions are remembered, so the
  map keeps its shape between sessions and after each analysis; dragged nodes
  stay where you put them.

Also fixed:

- Faded nodes did not fade under the WebGL renderer, so selecting a node left
  unrelated nodes at full strength.
- Opening the graph view laid the graph out twice.
- Double-clicking a node now searches around it inside the graph view, instead
  of opening the search window.

See [Graph View](docs/GRAPH_VIEW.md).

### Upgrading

Nothing changes in your graph or notes. The view saves its display settings in
`data.json` and node positions in a new `graph-layout.json` in the plugin
folder. The first open lays the graph out once; later opens reuse it.

## 0.7.2

**med-lit pages with Korean or accented names now import on a Mac.** A
project folder synced to a Mac can store its file names in decomposed Unicode
(NFD), while med-lit names the pages in its export in composed form (NFC). The
names then never matched, so those pages were left out as "leftover" pages, and
their entities joined the graph without one. The import now compares names in
composed form and writes the pages into the vault under those names. If an
earlier import left pages out, run **Update** on the project to add them.

### Upgrading

Nothing changes for an existing vault. If a med-lit import reported leftover
pages that are in fact part of the review, run **Update** on the project: the
missing pages are added, and the pages already imported are left as they are.

## 0.7.1: import literature reviews from med-lit-mcp

[**med-lit-mcp**](https://github.com/junhewk/med-lit-mcp) is a companion tool
for medical literature reviews, by the same author. It is an MCP server: you
work with it from Claude Code, Claude Desktop, Codex, ChatGPT desktop or
Hermes, and the agent takes a review question through
**search → screening → fetch → wiki**. Along the way it:

- searches PubMed, PMC, OpenAlex, Semantic Scholar, Scopus and Europe PMC,
- screens titles and abstracts, with every decision backed by a quote,
- fetches the full text where it is openly available, and
- writes a wiki: one page per article, one page per entity (conditions,
  interventions, technologies, methods, …) with an evidence-linked synthesis,
  and a knowledge graph of those entities and their relationships.

A scheduled **bot** can keep a review up to date, adding a few new articles a
day. Install it from [GitHub](https://github.com/junhewk/med-lit-mcp) or
[PyPI](https://pypi.org/project/med-lit-mcp/) (`uvx med-lit-mcp setup`).

Simple Graph Builder can now import such a project into your vault:

- **The pages stay together** in their own folder, named after the project
  (`<project>/sources`, `<project>/entities`, `<project>/updates`), apart from
  your notes and from the plugin's own entity notes.
- **Links become Obsidian wikilinks.** med-lit writes relative Markdown links;
  the import rewrites them to `[[<project>/entities/Empathy|Empathy]]`, so
  backlinks, the graph view and renames work as they do for your own notes.
- **Its knowledge graph joins yours.** med-lit's graph is merged into this
  plugin's graph, with no LLM extraction and no API calls. An entity med-lit
  found ("Large language models", acronym "LLM") becomes the same node as the
  "LLM" in your own notes, and relationships keep med-lit's verbatim quotes as
  evidence. med-lit's medical types are converted to this plugin's ten types by
  med-lit's own table.
- **Updating is the same command.** Import the project again after the bot has
  run and only what changed comes in. Pages you edited in Obsidian are kept and
  listed, never overwritten without your say-so.

Run **Import or update med-lit project**, or use **Settings → Imported
projects**. It needs med-lit-mcp 0.1.6 or later and the desktop app. See
[Importing med-lit Projects](docs/MED_LIT_IMPORT.md).

### Upgrading

Nothing changes for an existing vault. Importing a med-lit project adds an
`imports` entry to `data.json` and a copy of the project's graph to
`.obsidian/plugins/simple-graph-builder/med-lit/`.

## 0.7.0

**Agent access:** AI agents such as Claude Code, Codex and Claude Desktop can
query your vault and knowledge graph through a local, read-only
[MCP](https://modelcontextprotocol.io) server the plugin runs while Obsidian is
open. **Advanced search** ranks notes by text match and closeness in the graph,
with no API calls, and replaces Smart Search. Also new: DeepSeek, GPT-6 Luna,
and entities that follow renamed notes. See [Agent Access (MCP)](docs/AGENT_ACCESS.md).

### Upgrading

- **Smart Search is gone.** Its separate model settings are removed from your settings file on first load. **Search graph and notes** (same command, same hotkey) is the replacement inside Obsidian; for question answering, connect an agent through [Agent Access](docs/AGENT_ACCESS.md).
- **Model:** a stored `gpt-5.6-luna` becomes `gpt-6-luna`. Every other model choice, including `gpt-5.4-mini`, is left alone. New installs default to `gpt-6-luna` for OpenAI.
- **Nothing is re-analyzed.** The graph is unchanged, and the search index is built in memory from your notes the first time you search.

## 0.6.0

This release adds vault write-back and makes the data file smaller. Nothing is re-analyzed, no API calls are made, and no existing data is lost.

- **Your graph can now become Obsidian links.** Turn on **Create entity notes** under *Vault write-back* to get one note per entity — with the aliases entity resolution found, so Obsidian itself resolves "ML", "머신러닝" and "기계학습" to a single note — plus an optional `related:` property on each analyzed note. Both are off until you turn them on, and **Remove written links** undoes the property across the vault.
- **The data file shrinks — 44% on the 5,177-node vault this was tested against, 6.8 MB down to 3.8 MB.** Note nodes and their `mentions` / `links to` edges are no longer stored: they are rebuilt from your notes and Obsidian's link index every time the plugin loads, so keeping a second copy on disk only cost space. `mentions` is one edge per note-entity pair, usually the largest single population in the file. Your graph loads with exactly the same nodes and edges as before; the saving is larger the more entities per note you extract.
- **Frontmatter is no longer analyzed or hashed.** Tags and properties were being sent to the model as if they were prose. Notes are now compared by their body, so editing frontmatter — including the property this plugin writes — no longer costs an analysis. Notes analyzed by earlier versions are still recognized and will not be re-analyzed.

## 0.5.4

- **Connectivity is visible at a glance.** Node diameter now scales logarithmically with the number of visible connections, while edge opacity reflects the importance of both endpoints. Hover and selection preserve those relative sizes.
- **Settings are searchable on Obsidian 1.13+.** The settings tab now publishes declarative setting definitions while retaining compatibility with older supported Obsidian versions.
- **Popout windows are supported.** Layout scheduling uses window-scoped animation frames and timers.
- **Vault enumeration is user-triggered.** Markdown file paths are enumerated only after confirming **Analyze entire vault**, rather than when the settings page opens.

## 0.5.0

This release fixes a bug that made large graphs dense and slow to load, and repairs the damage automatically on first load. Nothing is re-analyzed and no API calls are made.

- **Redundant link edges are removed.** Wikilinks used to connect every entity in a note to every entity in each linked note, which grows as the square of the entities per note. One 141-note vault carried 188,097 such edges out of 191,436 — 98% of its graph, in a 115 MB data file. They are deleted on load.
- **Notes become nodes.** Each analyzed note now appears as a `NOTE` node that `mentions` its entities and `links to` the notes it wikilinks — one edge per link, as intended. The note layer is rebuilt from Obsidian's own link index. Turn it off with **Show note nodes**, or rebuild it any time with the **Rebuild note layer** command.
- **Duplicate Korean entities are merged.** Names were compared without Unicode normalization, so composed (NFC) and decomposed (NFD) Hangul — identical on screen, and what macOS puts in file paths — produced two separate nodes for one concept, and made Korean search miss. Names are now normalized to NFC everywhere, and existing duplicates are folded together, keeping both notes' references and the alternate spelling as an alias.
- **Rendering is faster.** The graph view uses WebGL where available, budgets edges as well as nodes, hides labels when zoomed out, and simplifies edges on large graphs.

The same vault above went from 191,436 edges / 115 MB to 7,449 edges / 6.3 MB, with average connections per node dropping from 178 to 6.6.

## 0.4.0

This release moves to each provider's current API. Two things happen automatically on first load:

- **Model IDs are migrated.** Retired IDs are rewritten to their current equivalents (for example `claude-sonnet-4-5-20250929` → `claude-sonnet-5`, `gpt-4o` → `gpt-5.6-luna`). Ollama model names are left alone, since those refer to models you have pulled locally. Check your model selection afterwards if you had a specific one configured.
- **Gemini embeddings are reset.** `text-embedding-004` was shut down in January 2026, so it is replaced by `gemini-embedding-001`. Stored embeddings from the old model are discarded and you will be prompted to recompute them; entity resolution is paused until you do. OpenAI and Ollama embeddings are unaffected.
