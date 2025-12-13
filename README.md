# Simple Graph Builder

This plugin builds a lightweight knowledge graph from users' Obsidian notes using LLM-powered entity extraction with a simple yet expressive ontology model to provide knowledge extraction, exploration, and RAG search. Since Obsidian provides wonderful links between notes, implementing ontology model would meet users' (especially researchers') needs.

![Graph View](https://raw.githubusercontent.com/junhewk/simple-graph-builder/master/docs/graph-view.png)

## Why Lightweight Ontology?

Traditional knowledge graphs often require complex schemas with dozens of relationship types, making them difficult to maintain and query. Simple Graph Builder takes a different approach:

- **Flexible Node Labels**: The LLM determines the most appropriate label for each entity (Person, Concept, Tool, Project, etc.) - no predefined restrictions
- **Fixed Relationship Types**: Only 5 universal relationship types that cover most knowledge connections
- **Detail Property**: Each relationship includes a `detail` field for nuanced descriptions without schema explosion

This design provides **80% of the expressiveness with 20% of the complexity**, making it easy to build, query, and maintain your personal knowledge graph.

## Features

- **Lightweight Ontology Model**: Simple but expressive - flexible node labels + 5 fixed relationship types with detail annotations
- **Smart Search**: AI-powered natural language queries over your knowledge graph with multi-path exploration
- **Entity Extraction**: Automatically extract entities from your notes using AI (configurable extraction depth)
- **Internal Link Support**: Automatically processes `[[wikilinks]]` to build note-to-note connections
- **Multiple LLM Support**: Works with Claude, OpenAI, Gemini, and Ollama (local)
- **Korean Language Support**: Bigram Jaccard similarity for robust Korean text matching (handles particles and spacing variations)
- **Interactive Graph View**: Visualize your knowledge graph with fCoSE force-directed layout
- **Large Graph Support**: Optimized for thousands of nodes with fast rendering
- **Note Neighborhood Panel**: See connections for the current note in a sidebar
- **Quick Access**: Ribbon icon menu for common actions
- **Status Bar**: Real-time graph statistics display

## Commands

| Command | Description |
|---------|-------------|
| `Analyze current note` | Extract entities from the active note |
| `Search related notes` | Find notes by entity name (exact/fuzzy match) |
| `Smart Search (AI)` | Natural language search using LLM to explore the graph |
| `Open graph view` | Show the knowledge graph visualization |
| `Open note neighborhood panel` | Show current note's connections in sidebar |
| `Remove current note from graph` | Remove active note from the graph |
| `Clear all graph data` | Reset the entire graph |

## Data Model

### Node Labels (Flexible)
The LLM determines appropriate labels for each entity:
- **Person, Organization, Team** - People and groups
- **Concept, Theory, Method, Technique** - Ideas and approaches
- **Project, Product, System** - Work items
- **Tool, Library, Framework, Software** - Technical tools
- **Event, Meeting, Conference** - Occurrences
- **Document, Paper, Book** - Written works
- **Place, Location** - Geography
- Any other appropriate label

### Relationship Types (Fixed)
| Type | Meaning | Example Details |
|------|---------|-----------------|
| `HAS_PART` | Parent/Child, Inclusion | "member of", "contains", "subtopic" |
| `LEADS_TO` | Causality, Sequence, Dependency | "causes", "blocks", "enables" |
| `ACTED_ON` | Creation, Modification, Usage | "created", "maintains", "uses" |
| `CITES` | Reference, Source, Evidence | "references", "based on", "quotes" |
| `RELATED_TO` | Loose association, Similarity | "similar to", "see also", "wikilink" |

## UI Elements

### Ribbon Icon
Click the graph icon in the left ribbon to access:
- Analyze current note
- Open graph view

### Status Bar
Shows real-time graph statistics with node counts by label.

### Note Neighborhood Panel
A sidebar panel showing:
- **Extracted Nodes**: Entities from the current note with label badges
- **Connected Nodes**: Grouped by label (Person, Concept, Tool, etc.)
- **Relationships**: Shows relationship type and detail for each connection
- Click nodes to see source notes and relationship details

## Settings

### API Configuration
- **API Provider**: Choose between Claude, OpenAI, Gemini, or Ollama
- **API Key**: Your API key (not needed for Ollama)
- **Model**: Select or enter a custom model name

### Analysis Settings
- **Extraction Mode**: Control extraction depth
  - *Simple*: Max 15 entities, 20 relationships (fast, low cost)
  - *Advanced*: Max 30 entities, 50 relationships (balanced)
  - *Maximum*: No limits (thorough extraction)
- **Auto-analyze on save**: Automatically analyze notes when you save them (2-second debounce)
- **Analyze entire vault**: Batch analyze all notes with progress tracking and cancellation support

### View Settings
- **Open graph in main window**: Toggle to open the graph visualization in a main tab instead of the right sidebar

### Data Management
- View graph statistics (nodes by label, relationships by type)
- Clear all graph data

## Installation

### From Obsidian Community Plugins
1. Open Settings → Community plugins
2. Search for "Simple Graph Builder"
3. Click Install, then Enable

### Manual Installation
1. Download `main.js`, `styles.css`, and `manifest.json` from the latest release
2. Create folder: `VaultFolder/.obsidian/plugins/simple-graph-builder/`
3. Copy the downloaded files into the folder
4. Reload Obsidian and enable the plugin

## Usage

### Quick Start
1. Configure your API key in Settings → Simple Graph Builder
2. Open a note and run command: `Analyze current note`
3. View results with command: `Open graph view`

### Graph View
- **Click** a node to highlight its connections
- **Double-click** a node to open search with that term
- **Hover** on edges to see relationship type and detail
- **Click** the background to reset highlights
- **Scroll** to zoom in/out
- **Drag** to pan around the graph

Node colors are determined by label (predefined colors for common labels, hash-based colors for others). Edge styles vary by relationship type.

### Search
Two search modes are available:

#### Basic Search
1. Run command: `Search related notes`
2. Enter a concept or entity name
3. Toggle **Exact match** for precise matching
4. Click results to navigate to notes

#### Smart Search (AI)
1. Run command: `Smart Search (AI)`
2. Enter a natural language question (e.g., "What methods did we use for the recommendation project?")
3. The LLM explores the graph using tool calls, following multiple paths
4. View the AI-generated answer with relevant nodes and source notes
5. Click source note links to navigate

**Note**: Smart Search requires models with tool calling support. Some Ollama models (`deepseek-r1:*`, `gemma3:*`) have limited support. Recommended: `qwen3:*`, `gpt-oss:*` for Ollama.

## API Costs

This plugin makes API calls to extract entities from your notes.

- **Claude, OpenAI, Gemini**: Each note analysis and Smart Search query will incur API costs based on your provider's pricing
- **Ollama**: Free (runs locally on your machine)

Consider using Ollama for cost-free operation, or batch analyze during off-peak hours to manage costs.

## Privacy

- Your notes are sent to the configured LLM provider for entity extraction
- No data is stored externally; all graph data stays in your vault
- Consider using Ollama for fully local, private processing

## Support

- [GitHub Issues](https://github.com/junhewk/simple-graph-builder/issues)
- [Documentation](https://github.com/junhewk/simple-graph-builder)

## License

MIT License - see [LICENSE](LICENSE) for details.
