# Simple Graph Builder

Build a knowledge graph from your Obsidian notes using LLM-powered entity extraction.

![Graph View](https://raw.githubusercontent.com/junhewk/simple-graph-builder/main/docs/graph-view.png)

## Features

- **Entity Extraction**: Automatically extract entities (people, concepts, methods, etc.) from your notes using AI
- **Knowledge Graph**: Build connections between notes through shared entities and keywords
- **Internal Link Support**: Automatically processes `[[wikilinks]]` to build note-to-note connections
- **Multiple LLM Support**: Works with Claude, OpenAI, Gemini, and Ollama (local)
- **Korean Language Support**: Full support for Korean text analysis and entity extraction
- **User-defined Keywords**: Define your own ontology terms for domain-specific analysis
- **Interactive Graph View**: Visualize your knowledge graph with fCoSE force-directed layout
- **Large Graph Support**: Optimized for thousands of nodes with fast rendering
- **Exact Search**: Find notes by exact entity/keyword match
- **Note Neighborhood Panel**: See connections for the current note in a sidebar
- **Quick Access**: Ribbon icon menu for common actions
- **Status Bar**: Real-time graph statistics display

## Commands

| Command | Description |
|---------|-------------|
| `Analyze current note` | Extract entities from the active note |
| `Search related notes` | Find notes by entity or keyword |
| `Open graph view` | Show the knowledge graph visualization |
| `Open note neighborhood panel` | Show current note's connections in sidebar |
| `Remove current note from graph` | Remove active note from the graph |
| `Clear all graph data` | Reset the entire graph |

## UI Elements

### Ribbon Icon
Click the graph icon in the left ribbon to access:
- Analyze current note
- Open graph view
- Search related notes
- Show note neighborhood
- Remove current note from graph

### Status Bar
Shows real-time graph statistics: `Graph: 5N 12E 3K` (Notes, Entities, Keywords)

### Note Neighborhood Panel
A sidebar panel showing:
- **Linked Notes**: Notes connected via internal links or shared entities
- **Entities**: Extracted concepts from the current note
- **Keywords**: Matched user-defined terms
- Click entities/keywords to see all connected notes

## Settings

### API Configuration
- **API Provider**: Choose between Claude, OpenAI, Gemini, or Ollama
- **API Key**: Your API key (not needed for Ollama)
- **Model**: Select or enter a custom model name

### Keywords
Define domain-specific terms that the LLM will identify in your notes. Examples:
- Research domains: `machine learning`, `clinical trial`, `regression analysis`
- Korean terms: `머신러닝`, `임상연구`, `회귀분석`

### Analysis Settings
- **Auto-analyze on save**: Automatically analyze notes when you save them (2-second debounce)
- **Analyze entire vault**: Batch analyze all notes with progress tracking and cancellation support

### Data Management
- View graph statistics (notes, entities, keywords, connections)
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
- **Double-click** a note node to open it
- **Double-click** an entity/keyword to search for related notes
- **Click** the background to reset highlights
- **Scroll** to zoom in/out
- **Drag** to pan around the graph

The graph uses fCoSE (fast Compound Spring Embedder) layout, optimized for large graphs with thousands of nodes.

### Search
1. Run command: `Search related notes`
2. Enter a concept, keyword, or topic
3. Toggle **Exact match** for precise matching (default: on)
   - ON: "AI기본법" only matches "AI기본법"
   - OFF: "AI기본법" matches "AI", "AI기본법", etc.
4. Click results to navigate to notes

## API Costs

This plugin makes API calls to extract entities. Approximate costs:
- **Claude**: ~$0.003 per note (Sonnet)
- **OpenAI**: ~$0.001 per note (GPT-4o-mini)
- **Gemini**: Free tier available
- **Ollama**: Free (runs locally)

## Privacy

- Your notes are sent to the configured LLM provider for entity extraction
- No data is stored externally; all graph data stays in your vault
- Consider using Ollama for fully local, private processing

## Support

- [GitHub Issues](https://github.com/junhewk/simple-graph-builder/issues)
- [Documentation](https://github.com/junhewk/simple-graph-builder)

## License

MIT License - see [LICENSE](LICENSE) for details.
