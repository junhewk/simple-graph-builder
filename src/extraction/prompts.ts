import { RelationshipType, ExtractionMode } from '../types';

/**
 * Get extraction limits based on mode.
 */
function getExtractionLimits(mode: ExtractionMode): { maxNodes: number | null; maxRelationships: number | null } {
	switch (mode) {
		case 'simple':
			return { maxNodes: 15, maxRelationships: 20 };
		case 'advanced':
			return { maxNodes: 30, maxRelationships: 50 };
		case 'maximum':
			return { maxNodes: null, maxRelationships: null };
	}
}

/**
 * Build the ontology extraction prompt for the LLM.
 * Extracts nodes with flexible labels and relationships with fixed types.
 */
export function buildExtractionPrompt(
	noteContent: string,
	existingNodeNames: string[],
	extractionMode: ExtractionMode = 'simple'
): string {
	const existingSection = existingNodeNames.length > 0
		? `**Existing nodes in knowledge graph (reuse these exact names when the same concept appears):**\n${existingNodeNames.slice(0, 100).join(', ')}${existingNodeNames.length > 100 ? ` ... and ${existingNodeNames.length - 100} more` : ''}`
		: '**Existing nodes:** (none yet - this is the first note)';

	const limits = getExtractionLimits(extractionMode);
	const constraintsSection = limits.maxNodes !== null
		? `**OUTPUT CONSTRAINTS (IMPORTANT):**
- Extract MAX ${limits.maxNodes} nodes and MAX ${limits.maxRelationships} relationships
- Keep node names SHORT (1-4 words)
- Keep detail property SHORT (1-3 words)
- No explanations, no markdown - JSON only
- Skip trivial terms (e.g., "thing", "item", "data", "information")`
		: `**OUTPUT CONSTRAINTS (IMPORTANT):**
- Extract ALL meaningful entities and relationships from the note
- Keep node names SHORT (1-4 words)
- Keep detail property SHORT (1-3 words)
- No explanations, no markdown - JSON only
- Skip trivial terms (e.g., "thing", "item", "data", "information")`;

	return `You are a Knowledge Graph Architect. Convert the note content into a structured JSON graph.

**Node Labels (choose appropriate labels - NOT limited to these examples):**
- Person, Organization, Team (for people and groups)
- Concept, Theory, Method, Technique (for ideas and approaches)
- Project, Product, System, Application (for work items)
- Tool, Library, Framework, Software (for technical tools)
- Event, Meeting, Conference (for occurrences)
- Place, Location (for geography)
- Document, Paper, Book, Article (for written works)
- Use any other appropriate label that best describes the entity

**Relationship Types (STRICTLY use ONLY these 5 types):**
- HAS_PART: Parent/Child, Inclusion, Sub-components ("member of", "contains", "subtopic of")
- LEADS_TO: Causality, Sequence, Dependency ("causes", "blocks", "enables", "results in")
- ACTED_ON: Creation, Modification, Usage, Ownership ("created", "maintains", "uses", "authored")
- CITES: Reference, Source, Evidence ("references", "based on", "according to", "quotes")
- RELATED_TO: Loose association, Similarity ("similar to", "see also", "compared with")

**CRITICAL RULES:**
1. Node labels are FLEXIBLE - use whatever label best fits the entity
2. Relationship types are FIXED - must be one of the 5 types above
3. Add "detail" property to EVERY relationship (1-3 words only)
4. Normalize names: merge synonyms/variants into a single canonical form
5. **Korean specific:** Remove Josa/particles from node names (e.g., "사람은" → "사람", "기술을" → "기술")
6. Korean preferred for Korean concepts: "ML"/"Machine Learning"/"머신러닝"/"기계학습" → "머신러닝"
7. English preferred for English-origin terms: "API"/"에이피아이" → "API"
8. Reuse existing node names when the same concept appears
9. Focus on domain-specific concepts, not generic words

${constraintsSection}

${existingSection}

**Note content:**
---
${noteContent}
---

**Output JSON (no markdown, no explanation):**
{"nodes":[{"id":"1","label":"Person","properties":{"name":"Alice"}},{"id":"2","label":"Project","properties":{"name":"Project Alpha"}}],"relationships":[{"source":"1","target":"2","type":"ACTED_ON","properties":{"detail":"lead architect"}}]}`;
}

/**
 * Build the smart search system prompt for the LLM.
 * The LLM will use tool calls to query the graph.
 */
export function buildSmartSearchSystemPrompt(): string {
	return `You are a Knowledge Graph Query Assistant. Answer the user's question by thoroughly exploring the knowledge graph using the provided tools.

**Available Tools:**
1. search_nodes(query, label?) - Search nodes by name (fuzzy match with Bigram Jaccard similarity for Korean support), optionally filter by label. Returns up to 20 results sorted by match score.
2. get_node(name) - Get a specific node with its properties and source notes
3. get_relationships(node_name, direction?, type?) - Get relationships for a node
   - direction: "outgoing" | "incoming" | "both" (default: "both")
   - type: "HAS_PART" | "LEADS_TO" | "ACTED_ON" | "CITES" | "RELATED_TO" (optional filter)
4. get_connected_nodes(node_name, hops?) - Get nodes connected within N hops (default: 2)
5. get_source_notes(node_name) - Get source notes where this node was extracted from

**Relationship Type Meanings:**
- HAS_PART: Parent/Child, Inclusion, Sub-components
- LEADS_TO: Causality, Sequence, Dependency
- ACTED_ON: Creation, Modification, Usage, Ownership
- CITES: Reference, Source, Evidence
- RELATED_TO: Loose association, Similarity

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
  "relevantNodes": [{"name": "...", "label": "...", "relevance": "why this is relevant"}],
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
					label: {
						type: 'string',
						description: 'Optional: filter results to nodes with this label (e.g., "Person", "Concept", "Tool")'
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
			description: 'Get relationships connected to a node, optionally filtered by direction and type.',
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
					},
					type: {
						type: 'string',
						enum: ['HAS_PART', 'LEADS_TO', 'ACTED_ON', 'CITES', 'RELATED_TO'],
						description: 'Filter by relationship type'
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
 * Valid relationship types for validation
 */
export const RELATIONSHIP_TYPES: RelationshipType[] = [
	'HAS_PART',
	'LEADS_TO',
	'ACTED_ON',
	'CITES',
	'RELATED_TO'
];

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
