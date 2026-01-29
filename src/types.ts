// ============================================
// Schema Version
// ============================================
export const GRAPH_SCHEMA_VERSION = 2;

// ============================================
// Legacy Types (v1) - kept for migration detection
// ============================================
export type LegacyNodeType = 'note' | 'entity' | 'keyword';
export type LegacyEdgeType = 'mentions' | 'matches_keyword' | 'relates_to' | 'links_to';

export interface LegacyGraphNode {
	id: string;
	type: LegacyNodeType;
	label: string;
	notePath?: string;
	createdAt?: number;
	updatedAt?: number;
}

export interface LegacyGraphEdge {
	id: string;
	source: string;
	target: string;
	type: LegacyEdgeType;
	createdAt?: number;
}

export interface LegacyGraphData {
	nodes: LegacyGraphNode[];
	edges: LegacyGraphEdge[];
	version: number;
}

// ============================================
// Ontology Model (v2)
// ============================================

/**
 * Relationship types - STRICTLY limited to these 5 types.
 * Use the `detail` property on edges for nuance.
 */
export type RelationshipType = 'HAS_PART' | 'LEADS_TO' | 'ACTED_ON' | 'CITES' | 'RELATED_TO';

/**
 * Ontology node with flexible LLM-determined labels.
 * Labels can be: Person, Concept, Tool, Event, Project, Method, etc.
 */
export interface OntologyNode {
	id: string;
	label: string;           // LLM-determined (Person, Concept, Tool, Event, etc.) - unlimited
	properties: {
		name: string;          // display name (required)
		aliases?: string[];    // alternative names for this entity (for resolution)
		[key: string]: unknown;  // additional properties
	};
	sourceNotes: string[];   // note paths that reference this node
	createdAt?: number;
	updatedAt?: number;
}

/**
 * Ontology edge with fixed relationship types and detail for nuance.
 */
export interface OntologyEdge {
	id: string;
	source: string;          // source node ID
	target: string;          // target node ID
	type: RelationshipType;  // MUST be one of the 5 types
	properties: {
		detail: string;        // required: explains specific nuance
		[key: string]: unknown;  // additional properties
	};
	sourceNote?: string;     // note path that created this relationship
	createdAt?: number;
}

/**
 * Graph data structure (v2 schema)
 */
export interface GraphData {
	nodes: OntologyNode[];
	edges: OntologyEdge[];
	version: number;        // schema version (should be 2)
}

// ============================================
// LLM Extraction Types
// ============================================

/**
 * Raw node from LLM extraction (before ID normalization)
 */
export interface RawExtractionNode {
	id: string;              // temporary ID used within extraction
	label: string;
	properties: {
		name: string;
		[key: string]: unknown;
	};
}

/**
 * Raw relationship from LLM extraction (before ID normalization)
 */
export interface RawExtractionRelationship {
	source: string;          // temporary ID from extraction
	target: string;          // temporary ID from extraction
	type: RelationshipType;
	properties: {
		detail: string;
		[key: string]: unknown;
	};
}

/**
 * LLM extraction result
 */
export interface OntologyExtractionResult {
	nodes: RawExtractionNode[];
	relationships: RawExtractionRelationship[];
}

// ============================================
// Graph Search Types (for smart search tools)
// ============================================

export interface SearchNodeResult {
	name: string;
	label: string;
	score: number;
}

export interface RelationshipResult {
	from: string;
	to: string;
	type: RelationshipType;
	detail: string;
}

export interface ConnectedNodeResult {
	name: string;
	label: string;
	path: string[];
}

export interface PathStep {
	node: string;
	via?: RelationshipType;
	detail?: string;
}

export interface PathResult {
	found: boolean;
	path: PathStep[];
}

export interface SourceNoteResult {
	path: string;
	title: string;
}

// ============================================
// API & Settings
// ============================================

export type ApiProvider = 'claude' | 'openai' | 'gemini' | 'ollama';

/**
 * Embedding provider options.
 * Note: Claude doesn't have an embeddings API, so it's not included here.
 */
export type EmbeddingProvider = 'openai' | 'gemini' | 'ollama';

/**
 * Extraction mode controls how thorough the entity extraction is.
 * - simple: Max 15 entities, 20 relationships (fast, low cost)
 * - advanced: Max 30 entities, 50 relationships (balanced)
 * - maximum: No limits (thorough, higher cost)
 */
export type ExtractionMode = 'simple' | 'advanced' | 'maximum';

export interface Settings {
	apiProvider: ApiProvider;
	apiKey: string;
	// Model selection per provider
	claudeModel: string;
	openaiModel: string;
	geminiModel: string;
	ollamaModel: string;
	ollamaHost: string;     // Ollama server URL (default: http://localhost:11434)
	// Extraction settings
	extractionMode: ExtractionMode;  // Controls extraction thoroughness
	// Auto-analysis
	autoAnalyzeOnSave: boolean;  // Analyze notes automatically when saved
	// View settings
	openGraphInMain: boolean;    // Open graph view in main window instead of sidebar
	// Embedding-based entity resolution (opt-in)
	enableEmbeddings: boolean;            // default: false - embeddings are opt-in to avoid API costs
	embeddingProvider: EmbeddingProvider; // default: 'openai'
	embeddingApiKey: string;              // separate key for embeddings (can differ from main provider)
	embeddingModel: string;               // default: 'text-embedding-3-small'
	resolutionThresholdHigh: number;      // default: 0.90 - auto-merge above this
	resolutionThresholdLow: number;       // default: 0.80 - LLM verification between low and high
	enableLLMVerification: boolean;       // default: true - use LLM for ambiguous matches
}

// Legacy type for compatibility with GraphNode references
export interface GraphNode {
	id: string;
	type: 'note' | 'entity' | 'keyword';
	label: string;
	notePath?: string;
}

// ============================================
// Content Hash Tracking
// ============================================

export interface NoteHash {
	path: string;
	hash: string;
	analyzedAt: number;     // timestamp of last analysis
}

export interface HashData {
	hashes: NoteHash[];
}

// ============================================
// Plugin Data Structure
// ============================================

// ============================================
// Entity Resolution Types
// ============================================

/**
 * Index metadata for binary embedding storage.
 * The actual embeddings are stored in a separate binary file.
 */
export interface EmbeddingIndex {
	nodeIds: string[];       // Ordered list of node IDs (index i corresponds to embedding i in binary file)
	model: string;           // e.g., "text-embedding-3-small"
	dimensions: number;      // 1536 for OpenAI, 768 for Gemini
	updatedAt: number;       // timestamp of last update
}

/**
 * Persistent resolution cache: maps raw tokens to canonical node IDs.
 * Used to remember previous resolution decisions across sessions.
 */
export interface ResolutionCache {
	[rawToken: string]: string;  // raw token (lowercase) → canonical node ID
}

/**
 * Result of entity resolution attempt.
 */
export interface ResolutionResult {
	nodeId: string;          // The resolved or newly created node ID
	matchType: 'cached' | 'session' | 'exact' | 'alias' | 'embedding_high' | 'embedding_verified' | 'new';
	confidence: number;      // 0.0 to 1.0
	mergedInto?: string;     // If merged, the name of the target node
}

/**
 * Stats from resolution during merge operation.
 */
export interface ResolutionStats {
	cached: number;          // resolved via persistent cache
	session: number;         // resolved via session cache
	exact: number;           // resolved via exact name match
	alias: number;           // resolved via alias match
	embeddingHigh: number;   // resolved via high-confidence embedding (auto-merge)
	embeddingVerified: number; // resolved via LLM-verified embedding match
	new: number;             // created as new entity
}

/**
 * Plugin data structure (stored via loadData/saveData)
 */
export interface PluginData {
	settings: Settings;
	graph: GraphData;
	hashes: HashData;
	resolutionCache?: ResolutionCache;   // Persistent token → node ID mappings
	embeddingIndex?: EmbeddingIndex;     // Metadata for embeddings.bin
}

// ============================================
// Utility Types
// ============================================

/**
 * Valid relationship types for validation
 */
export const VALID_RELATIONSHIP_TYPES: readonly RelationshipType[] = [
	'HAS_PART',
	'LEADS_TO',
	'ACTED_ON',
	'CITES',
	'RELATED_TO'
] as const;

/**
 * Check if a string is a valid relationship type
 */
export function isValidRelationshipType(type: string): type is RelationshipType {
	return VALID_RELATIONSHIP_TYPES.includes(type as RelationshipType);
}

/**
 * Check if graph data is v1 (legacy) format
 */
export function isLegacyGraphData(data: unknown): boolean {
	if (!data || typeof data !== 'object') return false;
	const graphData = data as { nodes?: unknown[]; version?: number };
	if (!graphData.nodes || !Array.isArray(graphData.nodes)) return false;
	if (graphData.nodes.length === 0) return false;

	// Check if first node has 'type' property (v1) instead of 'label' with 'properties' (v2)
	const firstNode = graphData.nodes[0] as Record<string, unknown>;
	return 'type' in firstNode && !('properties' in firstNode);
}
