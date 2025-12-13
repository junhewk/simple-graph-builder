/**
 * Graph query tool handlers for LLM smart search.
 * These functions implement the tools that the LLM can call to explore the knowledge graph.
 */

import type { GraphCache } from './cache';
import type {
	OntologyEdge,
	RelationshipType,
	SearchNodeResult,
	RelationshipResult,
	ConnectedNodeResult,
	SourceNoteResult,
} from '../types';

// ============================================
// Tool Result Types
// ============================================

export interface NodeDetails {
	name: string;
	label: string;
	properties: Record<string, unknown>;
	sourceNotes: string[];
}

// ============================================
// Tool Implementations
// ============================================

// ============================================
// Bigram Jaccard Similarity for Korean Support
// ============================================

/**
 * Generate bigrams (2-character chunks) from a string.
 * Ignores whitespace for better Korean matching (handles spacing variations).
 */
function generateBigrams(text: string): Set<string> {
	const normalized = text.toLowerCase().replace(/\s+/g, '');
	const bigrams = new Set<string>();

	for (let i = 0; i < normalized.length - 1; i++) {
		bigrams.add(normalized.slice(i, i + 2));
	}

	return bigrams;
}

/**
 * Calculate Jaccard similarity between two sets.
 * Returns value between 0 and 1.
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
	if (setA.size === 0 && setB.size === 0) return 0;

	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) {
			intersection++;
		}
	}

	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Calculate match score using Bigram Jaccard Similarity.
 * Handles Korean agglutinative language patterns (particles, spacing variations).
 *
 * Scoring Priority:
 * 1. Exact match: 1.0
 * 2. Starts with query: 0.9 + length bonus (handles particles like "AI는")
 * 3. Contains query: 0.7 + position bonus
 * 4. Bigram Jaccard similarity: 0.3-0.6 range (threshold > 0.3)
 */
function calculateMatchScore(query: string, name: string): number {
	const queryLower = query.toLowerCase().replace(/\s+/g, '');
	const nameLower = name.toLowerCase().replace(/\s+/g, '');

	// 1. Exact match (highest priority)
	if (nameLower === queryLower) {
		return 1.0;
	}

	// 2. Starts with query (handles Korean particles: "인공지능은" matches "인공지능")
	if (nameLower.startsWith(queryLower)) {
		// Bonus for closer length match
		const lengthRatio = queryLower.length / nameLower.length;
		return 0.9 + (lengthRatio * 0.09);
	}

	// 3. Contains query as substring
	if (nameLower.includes(queryLower)) {
		const position = nameLower.indexOf(queryLower);
		// Earlier position = higher score
		const positionBonus = Math.max(0, 0.1 - (position * 0.01));
		const lengthRatio = queryLower.length / nameLower.length;
		return 0.7 + (lengthRatio * 0.1) + positionBonus;
	}

	// 4. Query contains name (name is substring of query)
	if (queryLower.includes(nameLower)) {
		const lengthRatio = nameLower.length / queryLower.length;
		return 0.6 + (lengthRatio * 0.1);
	}

	// 5. Bigram Jaccard similarity (fallback for partial Korean matches)
	const queryBigrams = generateBigrams(query);
	const nameBigrams = generateBigrams(name);

	if (queryBigrams.size === 0 || nameBigrams.size === 0) {
		return 0;
	}

	const similarity = jaccardSimilarity(queryBigrams, nameBigrams);

	// Only return score if similarity exceeds threshold
	if (similarity > 0.3) {
		// Map similarity (0.3-1.0) to score range (0.3-0.6)
		return 0.3 + ((similarity - 0.3) * 0.43);
	}

	return 0;
}

/**
 * Search nodes by name using Bigram Jaccard Similarity.
 * Optimized for Korean language support (handles particles, spacing variations).
 * Returns nodes sorted by match score.
 */
export function searchNodes(
	cache: GraphCache,
	query: string,
	label?: string
): SearchNodeResult[] {
	const results: SearchNodeResult[] = [];
	const queryTrimmed = query.trim();

	if (!queryTrimmed) return [];

	for (const node of cache.getAllNodes()) {
		// Apply label filter if specified
		if (label && node.label !== label) {
			continue;
		}

		const score = calculateMatchScore(queryTrimmed, node.properties.name);

		if (score > 0) {
			results.push({
				name: node.properties.name,
				label: node.label,
				score: Math.round(score * 100) / 100,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

/**
 * Get detailed information about a specific node by name.
 */
export function getNode(cache: GraphCache, name: string): NodeDetails | null {
	const node = cache.getNodeByName(name);
	if (!node) return null;

	return {
		name: node.properties.name,
		label: node.label,
		properties: { ...node.properties },
		sourceNotes: [...node.sourceNotes],
	};
}

/**
 * Get relationships for a node, optionally filtered by direction and type.
 */
export function getRelationships(
	cache: GraphCache,
	nodeName: string,
	direction: 'outgoing' | 'incoming' | 'both' = 'both',
	type?: RelationshipType
): RelationshipResult[] {
	const node = cache.getNodeByName(nodeName);
	if (!node) return [];

	const results: RelationshipResult[] = [];

	// Get outgoing edges (where this node is the source)
	if (direction === 'outgoing' || direction === 'both') {
		for (const edge of cache.getEdgesBySource(node.id)) {
			if (type && edge.type !== type) continue;

			const targetNode = cache.getNodeById(edge.target);
			if (targetNode) {
				results.push({
					from: node.properties.name,
					to: targetNode.properties.name,
					type: edge.type,
					detail: edge.properties.detail,
				});
			}
		}
	}

	// Get incoming edges (where this node is the target)
	if (direction === 'incoming' || direction === 'both') {
		for (const edge of cache.getEdgesByTarget(node.id)) {
			if (type && edge.type !== type) continue;

			const sourceNode = cache.getNodeById(edge.source);
			if (sourceNode) {
				results.push({
					from: sourceNode.properties.name,
					to: node.properties.name,
					type: edge.type,
					detail: edge.properties.detail,
				});
			}
		}
	}

	return results;
}

/**
 * Get nodes connected to a node within N hops using BFS traversal.
 */
export function getConnectedNodes(
	cache: GraphCache,
	nodeName: string,
	hops = 2
): ConnectedNodeResult[] {
	const startNode = cache.getNodeByName(nodeName);
	if (!startNode) return [];

	// Limit hops to prevent excessive traversal
	const maxHops = Math.min(hops, 4);

	const visited = new Set<string>([startNode.id]);
	const queue: Array<{ id: string; path: string[]; depth: number }> = [
		{ id: startNode.id, path: [], depth: 0 }
	];
	const results: ConnectedNodeResult[] = [];

	while (queue.length > 0) {
		const { id, path, depth } = queue.shift()!;

		if (depth >= maxHops) continue;

		// Get all edges connected to this node
		const edges = cache.getConnectedEdges(id);

		for (const edge of edges) {
			const neighborId = edge.source === id ? edge.target : edge.source;

			if (!visited.has(neighborId)) {
				visited.add(neighborId);

				const neighborNode = cache.getNodeById(neighborId);
				if (neighborNode) {
					const newPath = [...path, neighborNode.properties.name];
					results.push({
						name: neighborNode.properties.name,
						label: neighborNode.label,
						path: newPath,
					});

					queue.push({
						id: neighborId,
						path: newPath,
						depth: depth + 1,
					});
				}
			}
		}
	}

	return results.slice(0, 50); // Limit results
}

/**
 * Get source notes where a node was extracted from.
 */
export function getSourceNotes(
	cache: GraphCache,
	nodeName: string
): SourceNoteResult[] {
	const node = cache.getNodeByName(nodeName);
	if (!node) return [];

	return node.sourceNotes.map(path => ({
		path,
		title: path.replace(/\.md$/, '').split('/').pop() || path,
	}));
}

/**
 * Find the shortest path between two nodes using BFS.
 */
export function findPath(
	cache: GraphCache,
	fromName: string,
	toName: string,
	maxHops = 4
): { found: boolean; path: Array<{ node: string; via?: RelationshipType; detail?: string }> } {
	const startNode = cache.getNodeByName(fromName);
	const endNode = cache.getNodeByName(toName);

	if (!startNode || !endNode) {
		return { found: false, path: [] };
	}

	if (startNode.id === endNode.id) {
		return { found: true, path: [{ node: startNode.properties.name }] };
	}

	const visited = new Map<string, { prev: string | null; edge: OntologyEdge | null }>();
	visited.set(startNode.id, { prev: null, edge: null });

	const queue: Array<{ id: string; depth: number }> = [{ id: startNode.id, depth: 0 }];

	while (queue.length > 0) {
		const { id: currentId, depth } = queue.shift()!;

		if (currentId === endNode.id) {
			// Reconstruct path
			const path: Array<{ node: string; via?: RelationshipType; detail?: string }> = [];
			let id: string | null = endNode.id;

			while (id) {
				const node = cache.getNodeById(id);
				const entry = visited.get(id);

				if (node) {
					path.unshift({
						node: node.properties.name,
						via: entry?.edge?.type,
						detail: entry?.edge?.properties.detail,
					});
				}

				id = entry?.prev ?? null;
			}

			return { found: true, path };
		}

		if (depth >= maxHops) continue;

		const edges = cache.getConnectedEdges(currentId);

		for (const edge of edges) {
			const neighborId = edge.source === currentId ? edge.target : edge.source;

			if (!visited.has(neighborId)) {
				visited.set(neighborId, { prev: currentId, edge });
				queue.push({ id: neighborId, depth: depth + 1 });
			}
		}
	}

	return { found: false, path: [] };
}

// ============================================
// Tool Handler Dispatcher
// ============================================

export type ToolName = 'search_nodes' | 'get_node' | 'get_relationships' | 'get_connected_nodes' | 'get_source_notes' | 'find_path';

export interface ToolCall {
	name: ToolName;
	arguments: Record<string, unknown>;
}

export interface ToolResult {
	name: ToolName;
	result: unknown;
}

/**
 * Execute a tool call and return the result.
 */
export function executeToolCall(cache: GraphCache, toolCall: ToolCall): ToolResult {
	const { name, arguments: args } = toolCall;

	switch (name) {
		case 'search_nodes':
			return {
				name,
				result: searchNodes(
					cache,
					args.query as string,
					args.label as string | undefined
				),
			};

		case 'get_node':
			return {
				name,
				result: getNode(cache, args.name as string),
			};

		case 'get_relationships':
			return {
				name,
				result: getRelationships(
					cache,
					args.node_name as string,
					args.direction as 'outgoing' | 'incoming' | 'both' | undefined,
					args.type as RelationshipType | undefined
				),
			};

		case 'get_connected_nodes':
			return {
				name,
				result: getConnectedNodes(
					cache,
					args.node_name as string,
					args.hops as number | undefined
				),
			};

		case 'get_source_notes':
			return {
				name,
				result: getSourceNotes(cache, args.node_name as string),
			};

		case 'find_path':
			return {
				name,
				result: findPath(
					cache,
					args.from_name as string,
					args.to_name as string,
					args.max_hops as number | undefined
				),
			};

		default:
			return {
				name,
				result: { error: `Unknown tool: ${name}` },
			};
	}
}
