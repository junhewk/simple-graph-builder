// ============================================
// Schema Version
// ============================================
export const GRAPH_SCHEMA_VERSION = 3;

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
// Ontology Model (v3)
// ============================================

/**
 * Entity types - STRICTLY limited to these 10 types.
 * LLM must choose one of these for each entity.
 */
export type EntityType =
	| 'PERSON'        // People, individuals, authors, researchers
	| 'ORGANIZATION'  // Companies, institutions, teams, communities
	| 'CONCEPT'       // Ideas, theories, principles, abstract notions
	| 'PROJECT'       // Projects, products, initiatives, goals
	| 'TOOL'          // Software, hardware, instruments, utilities
	| 'EVENT'         // Meetings, conferences, milestones, dates
	| 'PLACE'         // Locations, venues, geography
	| 'DOCUMENT'      // Papers, books, articles, notes, creative works
	| 'METHOD'        // Techniques, approaches, processes, workflows
	| 'TOPIC';        // Subjects, themes, fields, domains

/**
 * All valid entity types for validation
 */
export const VALID_ENTITY_TYPES: readonly EntityType[] = [
	'PERSON',
	'ORGANIZATION',
	'CONCEPT',
	'PROJECT',
	'TOOL',
	'EVENT',
	'PLACE',
	'DOCUMENT',
	'METHOD',
	'TOPIC'
] as const;

/**
 * Check if a string is a valid entity type
 */
export function isValidEntityType(type: string): type is EntityType {
	return VALID_ENTITY_TYPES.includes(type as EntityType);
}

// ============================================
// Entity Type Colors (shared across UI components)
// ============================================

/**
 * Color mapping for entity types.
 * Used in graph-view and neighborhood-view.
 */
export const ENTITY_TYPE_COLORS: Record<EntityType, string> = {
	PERSON: '#6366f1',       // indigo
	ORGANIZATION: '#8b5cf6', // violet
	CONCEPT: '#14b8a6',      // teal
	PROJECT: '#a855f7',      // purple
	TOOL: '#f59e0b',         // amber
	EVENT: '#ec4899',        // pink
	PLACE: '#22c55e',        // green
	DOCUMENT: '#3b82f6',     // blue
	METHOD: '#f97316',       // orange
	TOPIC: '#06b6d4',        // cyan
};

/**
 * Get color for entity type with fallback for legacy labels.
 */
export function getEntityTypeColor(entityType: string | undefined): string {
	if (!entityType) {
		return '#94a3b8'; // default gray
	}

	const knownColor = ENTITY_TYPE_COLORS[entityType as EntityType];
	if (knownColor) {
		return knownColor;
	}

	// Fallback for legacy labels - use hash-based color
	let hash = 0;
	for (let i = 0; i < entityType.length; i++) {
		hash = entityType.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 70%, 60%)`;
}

/**
 * Get entity type from a node with consistent fallback logic.
 * Handles both new (entityType) and legacy (label) fields.
 */
export function getNodeEntityType(node: { entityType?: EntityType; label?: string }): EntityType {
	if (node.entityType && isValidEntityType(node.entityType)) {
		return node.entityType;
	}
	if (node.label) {
		return labelToEntityType(node.label);
	}
	return 'CONCEPT';
}

/**
 * Get relationship verb from an edge with consistent fallback logic.
 * Handles both new (relationship) and legacy (type) fields.
 */
export function getEdgeRelationship(edge: { relationship?: string; type?: string }): string {
	if (edge.relationship) {
		return edge.relationship;
	}
	if (edge.type) {
		// Try to convert legacy type to verb
		const legacyTypeMap: Record<string, string> = {
			'HAS_PART': 'contains',
			'LEADS_TO': 'leads to',
			'ACTED_ON': 'acts on',
			'CITES': 'cites',
			'RELATED_TO': 'relates to',
		};
		return legacyTypeMap[edge.type.toUpperCase()] || edge.type;
	}
	return 'relates to';
}

/**
 * Ontology node with fixed entity types.
 */
export interface OntologyNode {
	id: string;
	entityType: EntityType;  // MUST be one of the 10 types
	label?: string;          // Legacy: kept for backwards compatibility
	properties: {
		name: string;          // display name (required)
		aliases?: string[];    // alternative names for this entity (for resolution)
		description?: string;  // brief description from LLM
		[key: string]: unknown;  // additional properties
	};
	sourceNotes: string[];   // note paths that reference this node
	createdAt?: number;
	updatedAt?: number;
}

/**
 * Ontology edge with free-form relationship verbs.
 */
export interface OntologyEdge {
	id: string;
	source: string;          // source node ID
	target: string;          // target node ID
	relationship: string;    // free-form verb (e.g., "develops", "uses", "causes")
	type?: string; // Legacy: kept for backwards compatibility
	properties: {
		detail?: string;       // optional: additional context
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
	entityType: EntityType;  // MUST be one of the 10 types
	label?: string;          // Legacy: kept for backwards compatibility
	properties: {
		name: string;
		description?: string;
		[key: string]: unknown;
	};
}

/**
 * Raw relationship from LLM extraction (before ID normalization)
 */
export interface RawExtractionRelationship {
	source: string;          // temporary ID from extraction
	target: string;          // temporary ID from extraction
	relationship: string;    // free-form verb (e.g., "develops", "uses")
	type?: string; // Legacy: kept for backwards compatibility
	properties: {
		detail?: string;       // optional description
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
	entityType: EntityType;
	label?: string;          // Legacy: for backwards compatibility
	score: number;
}

export interface RelationshipResult {
	from: string;
	to: string;
	relationship: string;    // free-form verb
	type?: string; // Legacy: for backwards compatibility
	detail?: string;
}

export interface ConnectedNodeResult {
	name: string;
	entityType: EntityType;
	label?: string;          // Legacy: for backwards compatibility
	path: string[];
}

export interface PathStep {
	node: string;
	via?: string;            // free-form relationship verb
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
 * - standard: Max 15 entities per chunk (fast, low cost)
 * - thorough: No limits on entities per chunk (comprehensive)
 */
export type ExtractionMode = 'standard' | 'thorough';

export interface Settings {
	apiProvider: ApiProvider;
	apiKey: string;
	// Model selection per provider (for KG building / extraction)
	claudeModel: string;
	openaiModel: string;
	geminiModel: string;
	ollamaModel: string;
	ollamaHost: string;     // Ollama server URL (default: http://localhost:11434)
	// Extraction settings
	extractionMode: ExtractionMode;  // Controls extraction thoroughness
	// Auto-analysis
	autoAnalyzeOnSave: boolean;  // Analyze notes automatically when saved
	// Smart Search model settings (separate from extraction)
	useSeparateSmartSearchModel: boolean;  // default: false - use same model as extraction
	smartSearchProvider: ApiProvider;      // default: same as apiProvider
	smartSearchClaudeModel: string;
	smartSearchOpenaiModel: string;
	smartSearchGeminiModel: string;
	smartSearchOllamaModel: string;
	// View settings
	openGraphInMain: boolean;    // Open graph view in main window instead of sidebar
	graphMinDegree: number;      // Minimum connections to show node in graph (default: 0)
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

/**
 * Map legacy label to EntityType for migration.
 */
export function labelToEntityType(label: string): EntityType {
	const labelLower = label.toLowerCase();

	// Person-related
	if (['person', 'author', 'researcher', 'individual'].includes(labelLower)) return 'PERSON';
	if (['team', 'group'].includes(labelLower)) return 'ORGANIZATION';

	// Organization-related
	if (['organization', 'company', 'institution', 'community'].includes(labelLower)) return 'ORGANIZATION';

	// Concept-related
	if (['concept', 'theory', 'principle', 'idea'].includes(labelLower)) return 'CONCEPT';

	// Project-related
	if (['project', 'product', 'system', 'initiative', 'application'].includes(labelLower)) return 'PROJECT';

	// Tool-related
	if (['tool', 'library', 'framework', 'software', 'hardware', 'instrument'].includes(labelLower)) return 'TOOL';

	// Event-related
	if (['event', 'meeting', 'conference', 'milestone'].includes(labelLower)) return 'EVENT';

	// Place-related
	if (['place', 'location', 'venue', 'geography'].includes(labelLower)) return 'PLACE';

	// Document-related
	if (['document', 'paper', 'book', 'article', 'note'].includes(labelLower)) return 'DOCUMENT';

	// Method-related
	if (['method', 'technique', 'approach', 'process', 'workflow'].includes(labelLower)) return 'METHOD';

	// Topic-related
	if (['topic', 'subject', 'theme', 'field', 'domain'].includes(labelLower)) return 'TOPIC';

	// Default to CONCEPT for unknown labels
	return 'CONCEPT';
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
