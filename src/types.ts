// Node types
export type NodeType = 'note' | 'entity' | 'keyword';

export interface GraphNode {
	id: string;
	type: NodeType;
	label: string;
	notePath?: string;      // for note nodes
	createdAt?: number;     // timestamp
	updatedAt?: number;     // timestamp
}

// Edge types
export type EdgeType = 'mentions' | 'matches_keyword' | 'relates_to' | 'links_to';

export interface GraphEdge {
	id: string;
	source: string;
	target: string;
	type: EdgeType;
	createdAt?: number;
}

export interface GraphData {
	nodes: GraphNode[];
	edges: GraphEdge[];
	version: number;        // schema version for future migrations
}

// API providers
export type ApiProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

export interface Settings {
	apiProvider: ApiProvider;
	apiKey: string;
	// Model selection per provider
	claudeModel: string;
	openaiModel: string;
	geminiModel: string;
	ollamaModel: string;
	ollamaHost: string;     // Ollama server URL (default: http://localhost:11434)
	keywords: string[];     // user-defined ontology terms
	// Auto-analysis
	autoAnalyzeOnSave: boolean;  // Analyze notes automatically when saved
}

// LLM extraction result
export interface ExtractionResult {
	entities: string[];
	keywordMatches: string[];
	relationships: Array<{
		source: string;
		target: string;
		type: 'relates_to';
	}>;
}

// Content hash tracking
export interface NoteHash {
	path: string;
	hash: string;
	analyzedAt: number;     // timestamp of last analysis
}

export interface HashData {
	hashes: NoteHash[];
}

// Plugin data structure (stored via loadData/saveData)
export interface PluginData {
	settings: Settings;
	graph: GraphData;
	hashes: HashData;
}
