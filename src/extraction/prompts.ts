import { ExtractionMode, VALID_ENTITY_TYPES } from '../types';

// ============================================
// Content Chunking
// ============================================

/**
 * Split content into chunks for parallel processing.
 * Target ~500 tokens per chunk (~3 chars per token as compromise between EN ~4 and KR ~2).
 */
export function chunkContent(content: string, targetTokens = 500): string[] {
	const chunkSize = targetTokens * 3; // ~1500 chars per chunk

	const paragraphs = content.split(/\n\n+/);
	const chunks: string[] = [];
	let current = '';

	for (const para of paragraphs) {
		if (current.length + para.length > chunkSize && current) {
			chunks.push(current.trim());
			current = para;
		} else {
			current += (current ? '\n\n' : '') + para;
		}
	}

	if (current.trim()) {
		chunks.push(current.trim());
	}

	// Ensure at least one chunk
	return chunks.length > 0 ? chunks : [content];
}

/**
 * Get extraction limits based on mode.
 * - standard: Max 15 entities per chunk
 * - thorough: No limits
 */
function getExtractionLimits(mode: ExtractionMode): { maxEntities: number | null } {
	switch (mode) {
		case 'standard':
			return { maxEntities: 15 };
		case 'thorough':
			return { maxEntities: null };
	}
}

/**
 * Build the ontology extraction prompt for the LLM.
 * Extracts entities with fixed types and relationships as free-form verbs.
 */
export function buildExtractionPrompt(
	noteContent: string,
	existingNodeNames: string[],
	extractionMode: ExtractionMode = 'standard'
): string {
	const existingSection = existingNodeNames.length > 0
		? `## Existing Entities (reuse exact names when applicable)
${existingNodeNames.slice(0, 100).join(', ')}${existingNodeNames.length > 100 ? ` ... and ${existingNodeNames.length - 100} more` : ''}`
		: '';

	const limits = getExtractionLimits(extractionMode);
	const limitInstruction = limits.maxEntities !== null
		? `Extract up to ${limits.maxEntities} most significant entities.`
		: `Extract ALL significant entities.`;

	const entityTypesList = VALID_ENTITY_TYPES.join(', ');

	return `You are a knowledge graph builder. Extract entities and relationships from the text below.

## Entity Types (use ONLY these 10)
- PERSON: People, individuals, authors, researchers
- ORGANIZATION: Companies, institutions, teams, communities
- CONCEPT: Ideas, theories, principles, abstract notions
- PROJECT: Projects, products, initiatives, goals
- TOOL: Software, hardware, instruments, utilities
- EVENT: Meetings, conferences, milestones, dates
- PLACE: Locations, venues, geography
- DOCUMENT: Papers, books, articles, notes, creative works
- METHOD: Techniques, approaches, processes, workflows
- TOPIC: Subjects, themes, fields, domains

## Guidelines
1. ${limitInstruction}
2. Use canonical names (expand acronyms except well-known: API, AI, ML)
3. Relationships: use active verbs ("develops", "uses", "causes", "cites", "contains")
4. Korean: Remove particles (Josa), prefer Korean for Korean concepts
5. Keep names SHORT (1-4 words)
6. Skip trivial terms ("thing", "item", "data", "information")

${existingSection}

## Text
${noteContent}

## Output (JSON only, no markdown)
{"entities":[{"name":"...","entity_type":"${entityTypesList.split(', ')[0]}","description":"..."}],"relationships":[{"source":"...","target":"...","relationship":"develops","description":"..."}]}`;
}

/**
 * Build the smart search system prompt for the LLM.
 * The LLM will use tool calls to query the graph.
 */
export function buildSmartSearchSystemPrompt(): string {
	return `You are a Knowledge Graph Query Assistant. Answer the user's question by thoroughly exploring the knowledge graph using the provided tools.

**Available Tools:**
1. search_nodes(query, entity_type?) - Search nodes by name (fuzzy match with Bigram Jaccard similarity for Korean support), optionally filter by entity type. Returns up to 20 results sorted by match score.
2. get_node(name) - Get a specific node with its properties and source notes
3. get_relationships(node_name, direction?) - Get relationships for a node
   - direction: "outgoing" | "incoming" | "both" (default: "both")
   - Relationships are free-form verbs like "develops", "uses", "causes", "cites"
4. get_connected_nodes(node_name, hops?) - Get nodes connected within N hops (default: 2)
5. get_source_notes(node_name) - Get source notes where this node was extracted from

**Entity Types:**
PERSON, ORGANIZATION, CONCEPT, PROJECT, TOOL, EVENT, PLACE, DOCUMENT, METHOD, TOPIC

**Relationships:**
Relationships are expressed as active verbs describing how entities connect (e.g., "develops", "uses", "causes", "cites", "contains", "manages").

**CRITICAL: Multi-Path Exploration Strategy**
You MUST explore multiple paths to provide comprehensive answers. Follow this process:

1. **Initial Search**: Use search_nodes to find relevant starting points.
   - If the search returns multiple matches (score > 0.5), you MUST explore AT LEAST the top 3 results.
   - Do NOT stop after exploring just one node.

2. **Branch Exploration**: For EACH relevant node found:
   - Call get_relationships to discover ALL connections (not just the first one)
   - If a node has multiple relationships, explore each branch
   - Example: If "Job Loss" connects to both "Demis Hassabis" AND "Dario Amodei", explore BOTH paths

3. **Depth vs Breadth**:
   - First explore breadth: check relationships for all top search results
   - Then explore depth: follow interesting connections 1-2 hops further

4. **Source Collection**: Use get_source_notes for nodes that directly answer the question

5. **Synthesis**: Combine findings from ALL explored paths into a comprehensive answer

**Common Mistakes to Avoid:**
- ❌ Stopping after finding one relevant node
- ❌ Only following the first relationship in a list
- ❌ Ignoring nodes with lower (but still relevant) match scores
- ✅ Exploring multiple branches systematically
- ✅ Mentioning ALL relevant connections in the answer

**Response Format:**
After thorough exploration, provide your final answer as JSON:
{
  "answer": "Comprehensive natural language answer. Mention ALL relevant connections found, not just one path. If multiple entities are connected to the query, list them all.",
  "relevantNodes": [{"name": "...", "entityType": "...", "relevance": "why this is relevant"}],
  "sourceNotes": [{"path": "...", "title": "...", "relevance": "what info came from this note"}]
}

Always cite which notes contain the relevant information. If you found multiple paths/connections, explicitly mention all of them in your answer.`;
}

/**
 * Get tool definitions for smart search.
 * These are sent to the LLM for tool calling.
 */
export function getSmartSearchTools(): SmartSearchToolDefinition[] {
	return [
		{
			name: 'search_nodes',
			description: 'Search nodes by name using Bigram Jaccard similarity (optimized for Korean). Scoring: exact match (1.0) > starts with (0.9+) > contains (0.7+) > bigram similarity (0.3-0.6). Returns up to 20 nodes sorted by match score. IMPORTANT: If multiple results have score > 0.5, explore ALL of them.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'The search query to match against node names. Works with Korean (handles particles/spacing) and English.'
					},
					entity_type: {
						type: 'string',
						description: 'Optional: filter results to nodes with this entity type (PERSON, ORGANIZATION, CONCEPT, PROJECT, TOOL, EVENT, PLACE, DOCUMENT, METHOD, TOPIC)'
					}
				},
				required: ['query']
			}
		},
		{
			name: 'get_node',
			description: 'Get detailed information about a specific node by name.',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'The exact name of the node to retrieve'
					}
				},
				required: ['name']
			}
		},
		{
			name: 'get_relationships',
			description: 'Get relationships connected to a node, optionally filtered by direction. Relationships are free-form verbs like "develops", "uses", "causes".',
			parameters: {
				type: 'object',
				properties: {
					node_name: {
						type: 'string',
						description: 'The name of the node to get relationships for'
					},
					direction: {
						type: 'string',
						enum: ['outgoing', 'incoming', 'both'],
						description: 'Filter by relationship direction (default: both)'
					}
				},
				required: ['node_name']
			}
		},
		{
			name: 'get_connected_nodes',
			description: 'Get all nodes connected to a node within N hops using BFS traversal.',
			parameters: {
				type: 'object',
				properties: {
					node_name: {
						type: 'string',
						description: 'The name of the starting node'
					},
					hops: {
						type: 'number',
						description: 'Maximum number of hops to traverse (default: 2, max: 4)'
					}
				},
				required: ['node_name']
			}
		},
		{
			name: 'get_source_notes',
			description: 'Get the source notes where a node was extracted from.',
			parameters: {
				type: 'object',
				properties: {
					node_name: {
						type: 'string',
						description: 'The name of the node to find sources for'
					}
				},
				required: ['node_name']
			}
		}
	];
}

/**
 * Tool definition structure for smart search
 */
export interface SmartSearchToolDefinition {
	name: string;
	description: string;
	parameters: {
		type: 'object';
		properties: Record<string, {
			type: string;
			description: string;
			enum?: string[];
		}>;
		required: string[];
	};
}


/**
 * Truncate note content if too long for API limits.
 * Preserves beginning and end of content.
 */
export function truncateContent(content: string, maxLength = 12000): string {
	if (content.length <= maxLength) {
		return content;
	}

	const halfLength = Math.floor(maxLength / 2) - 50;
	const beginning = content.slice(0, halfLength);
	const ending = content.slice(-halfLength);

	return `${beginning}\n\n[... content truncated for length ...]\n\n${ending}`;
}
