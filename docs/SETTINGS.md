# Settings

Everything under **Settings → Simple Graph Builder**. The graph view's own
display and force settings are set in the view itself; see
[Graph View](GRAPH_VIEW.md#display-and-forces).

On Obsidian 1.13 and later, **Excluded files** and the sections under
**Advanced** (agent access, vault write-back, entity resolution and imported
projects) each open on a page of their own, with their current state shown on
the row, as Obsidian's own settings do.

## API Configuration
- **API Provider**: Choose between Claude, OpenAI, Gemini, DeepSeek, or Ollama (local)
- **API Key**: Stored per provider, so switching providers never sends one provider's key to another. Not needed for a local server unless it was started with `--api-key`.
- **Server API** (local only): Which API the local server speaks — *Ollama* (`/api/chat`) or *OpenAI-compatible* (`/v1/chat/completions`). Use OpenAI-compatible for llama.cpp's `llama-server`, LM Studio, vLLM and similar; set **Host** to the base address without the `/v1` suffix.
- **Model**: Select or enter a custom model name

## Analysis Settings
- **Auto-analyze on save**: Analyze a note each time you save it (2-second debounce), so new and edited notes join the graph without another vault analysis
- **Analyze entire vault**: First counts, on your computer, which eligible notes are new and which changed since their last analysis, and shows those numbers with the unchanged, too-short and excluded notes it will skip. Nothing is sent until you confirm, and then only the new and changed notes are, with progress tracking and cancellation support
- **Extraction Mode**: Control extraction depth
  - *Standard*: Max 15 entities per chunk (fast, low cost)
  - *Thorough*: No limits per chunk (comprehensive extraction)
- **Reasoning effort**: How much the model thinks before extracting — *Auto*, *Minimal*, *Low*, *Medium*, *High*, or *Max*. Defaults to *Minimal*: notes are processed in many parallel chunks, so higher levels raise cost and latency noticeably. Models that don't support the setting (such as `claude-haiku-4-5`) are flagged in settings and simply ignore it.
- **Chunked Processing**: Long notes are automatically split into ~500 token chunks and processed in parallel (max 3 concurrent)

## Analysis Exclusions

Under **Analysis → Excluded files**, add one vault-relative path or pattern per
line to **Excluded files and folders**. Exclusions apply to **Analyze current note**, **Analyze entire
vault**, and **Auto-analyze on save**, before note content is read or sent to a
provider. Vault analysis reports excluded notes separately from unchanged or
short notes.

| Pattern | Excludes |
|---------|----------|
| `skills` or `skills/` | The root `skills` folder and all its descendants |
| `skills/**` | Everything beneath the root `skills` folder |
| `templates/*.md` | Markdown files immediately inside `templates` |
| `**/SKILL.md` | Files named `SKILL.md` anywhere, including the vault root |
| `notes/draft.md` | That exact file |

Patterns are anchored at the vault root. `*` matches characters within a path
segment, `?` matches one character, and a whole `**` segment crosses any number of
folders. Other characters are literal; regex, negation, and comment syntax are
not supported. Blank lines and surrounding whitespace are ignored. Matching is
case-insensitive and Unicode-normalized; both `/` and `\` separators work.

**Respect Obsidian excluded files** additionally honors **Files and links →
Excluded files**, using Obsidian’s matching rules rather than interpreting its
entries as plugin globs. This toggle is off by default. If the native matcher is
unavailable, the plugin stops opted-in analysis and asks you to turn the toggle
off; your custom patterns continue to work with it off.

Changing exclusions affects queued and future analysis; a note already being
analyzed finishes. Existing graph data, search results, and written links are
kept. Use **Remove current note from graph** to remove prior contributions.
Standalone write-back commands remain independent of analysis exclusions.
Plugin-managed entity notes are always excluded from analysis.

## Entity Resolution (Opt-in)
Enable embedding-based entity resolution for intelligent deduplication:
- **Enable embeddings**: Turn on the hybrid resolution pipeline
- **Embedding provider**: OpenAI, Gemini, or a local server — chosen independently of the chat provider, so a local chat model does not force local embeddings
- **Embedding server API** (local only): *Ollama* (`/api/embed`) or *OpenAI-compatible* (`/v1/embeddings`), set separately from the chat provider's API
- **Embedding server host** (local only): leave blank to reuse the chat provider's host; set it when embeddings run elsewhere
- **Embedding API key**: Separate key for embedding API calls
- **Embedding model**:
  - OpenAI: `text-embedding-3-small` (1536 dims), `text-embedding-3-large` (3072 dims)
  - Gemini: `gemini-embedding-001` (768 / 1536 / 3072 dims)
  - Ollama: `nomic-embed-text` (768 dims), `mxbai-embed-large` (1024 dims)
- **High confidence threshold**: Auto-merge above this similarity (default: 0.90)
- **Low confidence threshold**: LLM verification range floor (default: 0.80)
- **Enable LLM verification**: Verify ambiguous matches with LLM calls
- **Compute embeddings**: Generate embeddings for existing nodes
- **Clear resolution cache**: Reset learned token mappings

## View
- **Open graph in main window**: Toggle to open the graph visualization in a main tab instead of the right sidebar
- **Show note nodes**: Include your notes in the graph alongside the entities they mention. Turn off for an entity-only view
- **Minimum connections**: Hide nodes with fewer than this many connections

## Vault Write-Back (Opt-in)
Off by default. This is the only part of the plugin that writes into your notes.

- **Create entity notes**: master toggle. Writes one note per entity, carrying its aliases, type and relationships
- **Entity folder**: where those notes live (default `Entities`). Notes in this folder are never analyzed
- **List relationships in entity notes**: adds a Relationships section linking each entity to the ones it connects to, so entity-to-entity edges show up in Obsidian's own graph
- **Link notes to their entities**: adds a property to each analyzed note listing the entities found in it
- **Property name**: which frontmatter property that is (default `related`)
- **Write links for the whole vault** / **Remove written links**: apply or undo across the vault; no API calls either way

**What the plugin edits, exactly:** in your own notes, only that one property — your prose is never touched. In entity notes, the `aliases`, `entity-type` and `sgb-id` properties and the text between the `%% sgb:managed:start %%` and `%% sgb:managed:end %%` markers. Anything you write outside those markers is kept through every regeneration, and a file that does not carry the plugin's `sgb-id` is never overwritten or deleted.

## Agent access

See [Agent Access (MCP)](AGENT_ACCESS.md).

## Imported projects

See [Importing med-lit Projects](MED_LIT_IMPORT.md#managing-imported-projects).

## Data Management
- View graph statistics (nodes by entity type, total relationships)
- Clear all graph data

## Support
- **Show what's new after updates**: on by default. After a feature update (0.9.0, not 0.9.1), shows that release's changelog once. A fresh install shows nothing, and nothing is fetched: the notes are bundled with the plugin
