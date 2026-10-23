# Agent Access (MCP)

Off by default, desktop only. When on, this plugin runs an
[MCP](https://modelcontextprotocol.io) server inside Obsidian at
`http://127.0.0.1:27180/mcp` that agents can query while Obsidian is open.
Obsidian itself has no MCP support; the server is this plugin's, and it
stops when Obsidian quits or the plugin is disabled. It is unrelated to other
plugins' servers, such as Local REST API.

- **Agent access**: master toggle
- **Status**: running, or why it is not (for example, the port is taken by another vault)
- **Let agents add to the graph**: off by default. Lets a connected agent analyze notes with its own model and add the results to the graph, so you need no API key in this plugin. See [Building the graph with an agent](#building-the-graph-with-an-agent)
- **Port**: change it if something else uses 27180, then copy the settings again
- **Access token**: every request must carry it. It is kept in this device's local storage, not in the vault, so it is never synced or committed. **Regenerate** disconnects every configured agent
- **Claude Code**: copies one command to run in a terminal:
  ```bash
  claude mcp add --transport http --scope user obsidian-graph http://127.0.0.1:27180/mcp --header "Authorization: Bearer <token>"
  ```
- **Codex**: copies a block for `~/.codex/config.toml`:
  ```toml
  [mcp_servers.obsidian-graph]
  url = "http://127.0.0.1:27180/mcp"
  http_headers = { "Authorization" = "Bearer <token>" }
  ```
- **Claude Desktop**: copies an entry for `claude_desktop_config.json` (Claude Desktop → Settings → Developer → Edit config). Claude Desktop only starts local command-line servers, so the entry runs a small bridge script, `mcp-bridge.cjs`, that the plugin keeps in its own folder. It needs [Node.js](https://nodejs.org)
- **Node.js executable**: if Claude Desktop cannot find `node`, enter its full path (`which node` in a terminal)

The agent gets six read-only tools, and three more for
[building the graph](#building-the-graph-with-an-agent) if you allow it:

| Tool | What it returns |
|------|-----------------|
| `search` | Notes and entities ranked by text match and graph proximity, each with the matched words and the entities that connect it to the query |
| `get_entity` | An entity's type, description and aliases, the notes it came from, and its relations in both directions with the source note of each |
| `get_note` | A note's tags, links, backlinks, mentioned entities and related notes (by shared entities), and optionally its text |
| `neighbors` | Entities within 1–3 relation hops, with the path of verbs that reaches each |
| `find_path` | How two entities or notes connect, step by step |
| `graph_overview` | Counts, entity types, the most central entities and the most common relations |

Agents are told to cite notes as `[[wikilinks]]` and to treat note text as data,
not instructions.

## Building the graph with an agent

With **Let agents add to the graph** on, the agent can do the analysis
itself, with the model and subscription it already uses (for example, Claude
Code on a Claude plan). Ask it something like "analyze the notes in my
Projects folder", and it uses three more tools:

| Tool | What it does |
|------|--------------|
| `notes_to_analyze` | Lists notes that are new or changed since they were last analyzed, optionally under one folder |
| `get_extraction_task` | Returns a note's text, the same entity types and rules the plugin gives its own providers, existing entity names to reuse, and a hash of the note |
| `submit_extraction` | Takes the entities and relationships the agent extracted, checks them, and adds them to the graph |

How it behaves:

- **Results are checked like a provider's.** They go through the same parser
  as replies from the plugin's own providers, so an unknown entity type or a
  relationship to an entity that is not in the submission is dropped. The
  agent is told what was dropped and why, so it can fix it.
- **Stale results are refused.** If the note changed after the agent read it,
  the submission is rejected and the agent reads the note again.
- **It only adds.** A submission adds entities and relationships, the same as
  analyzing a note in Obsidian; nothing is removed, and the note's text is
  never edited. If [vault write-back](SETTINGS.md#vault-write-back-opt-in) is on,
  entity notes and `related:` links are written as they are for any analysis.
- **Analyzed is analyzed.** A note the agent submits is recorded as analyzed,
  so **Analyze entire vault** skips it until it changes, and the other way
  round. Submissions are refused while **Analyze entire vault** is running.
- **Exclusions still apply.** Excluded notes are not listed, cannot be read,
  and cannot be submitted.
- **Merging similar entities.** If [entity resolution](SETTINGS.md#entity-resolution-opt-in)
  is on, submissions use embeddings to merge similar entities, which needs
  the embedding provider configured. LLM verification of borderline matches
  is skipped when no chat provider is configured.

Each note's full text passes through the agent's context, so analyzing a large
vault this way is slower than **Analyze entire vault** and uses a lot of the
agent's context. Results also depend on the agent's model.

Turning the setting on or off takes effect at once, but some agents only pick
up new tools when they reconnect (in Claude Code, `/mcp`).

**How relationships reach the agent.** The graph combines three kinds of connection:

| Kind | Example | Source |
|------|---------|--------|
| Entity → entity relation | Anthropic —develops→ Claude | Extracted by the LLM during analysis, with a free-form verb, an optional detail, and the note it came from |
| Note → entity mention | *AI 기본법.md* mentions 인공지능 | Which notes each entity was extracted from |
| Note → note link | `[[240604 질병청 간담회]]` | Obsidian's own resolved wikilinks, for every note, analyzed or not |

Each tool uses them differently:

- **`search`** combines all three into one network and spreads relevance outward from what your words matched. Relations and mentions count fully; wikilinks count half.
- **`get_entity`** and **`neighbors`** return relations, with verb, direction, detail and the note each came from.
- **`get_note`** returns links, backlinks and mentioned entities.
- **`find_path`** tries relations first, then goes through notes.

A relation is served only when both of its entities and its source note are visible. Relation quality is only as good as extraction: verbs are not standardized, and duplicate entities (say, "AI" and "인공지능") split the graph until they are merged.

**What agents can and cannot see.** Only Markdown notes, and never anything in
`.obsidian` or other dot folders. Notes matching your
[analysis exclusions](SETTINGS.md#analysis-exclusions) are never served: not by search,
not by path, and not as the evidence behind a relation. Nor is an entity that
was extracted only from excluded notes. An entity that also appears in a
visible note is served, and its description may reflect every note it was
extracted from. The server listens on 127.0.0.1 only and refuses requests from
web pages. Unless you let agents add to the graph, it cannot change anything;
even then it changes only the graph, never a note's text.
