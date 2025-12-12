import { GraphData, GraphNode } from '../types';
import type { GraphCache } from './cache';

export interface SearchResult {
	notePath: string;
	noteLabel: string;
	score: number;
	matchedEntities: string[];
}

export interface SearchOptions {
	exactMatch?: boolean;
}

/**
 * Search graph using GraphCache (O(1) lookups via indexes).
 */
export function searchGraphCache(cache: GraphCache, query: string, options?: SearchOptions): SearchResult[] {
	const queryLower = query.toLowerCase().trim();
	if (!queryLower) return [];

	const exactMatch = options?.exactMatch ?? false;

	// Find matching entity/keyword nodes
	const matchingNodes: GraphNode[] = [];
	for (const node of [...cache.getNodesByType('entity'), ...cache.getNodesByType('keyword')]) {
		const labelLower = node.label.toLowerCase();

		if (exactMatch) {
			// Exact match: label must equal query exactly
			if (labelLower === queryLower) {
				matchingNodes.push(node);
			}
		} else {
			// Fuzzy match: substring matching
			if (labelLower.includes(queryLower) || queryLower.includes(labelLower)) {
				matchingNodes.push(node);
			}
		}
	}

	// Find notes connected to matching nodes (using indexed edge lookups)
	const noteScores = new Map<string, { score: number; entities: string[] }>();

	for (const matchNode of matchingNodes) {
		// Find edges where this node is target (note -> entity/keyword)
		const connectedEdges = cache.getEdgesByTarget(matchNode.id);

		for (const edge of connectedEdges) {
			const sourceNode = cache.getNodeById(edge.source);
			if (sourceNode?.type === 'note' && sourceNode.notePath) {
				const existing = noteScores.get(sourceNode.notePath) ?? { score: 0, entities: [] };
				existing.score += 1;
				existing.entities.push(matchNode.label);
				noteScores.set(sourceNode.notePath, existing);
			}
		}
	}

	// Convert to results and sort by score
	const results: SearchResult[] = [];
	for (const [notePath, data] of noteScores) {
		const noteNode = cache.getNodeByNotePath(notePath);
		results.push({
			notePath,
			noteLabel: noteNode?.label ?? notePath,
			score: data.score,
			matchedEntities: [...new Set(data.entities)],
		});
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search graph using raw GraphData (for backwards compatibility).
 * @deprecated Use searchGraphCache for better performance.
 */
export function searchGraph(graph: GraphData, query: string): SearchResult[] {
	const queryLower = query.toLowerCase().trim();
	if (!queryLower) return [];

	// Find matching entity/keyword nodes
	const matchingNodes = graph.nodes.filter(node => {
		if (node.type === 'note') return false;
		const labelLower = node.label.toLowerCase();
		return labelLower.includes(queryLower) || queryLower.includes(labelLower);
	});

	// Find notes connected to matching nodes
	const noteScores = new Map<string, { score: number; entities: string[] }>();

	for (const matchNode of matchingNodes) {
		// Find edges where this node is target (note -> entity/keyword)
		const connectedEdges = graph.edges.filter(e => e.target === matchNode.id);

		for (const edge of connectedEdges) {
			const sourceNode = graph.nodes.find(n => n.id === edge.source);
			if (sourceNode?.type === 'note' && sourceNode.notePath) {
				const existing = noteScores.get(sourceNode.notePath) ?? { score: 0, entities: [] };
				existing.score += 1;
				existing.entities.push(matchNode.label);
				noteScores.set(sourceNode.notePath, existing);
			}
		}
	}

	// Convert to results and sort by score
	const results: SearchResult[] = [];
	for (const [notePath, data] of noteScores) {
		const noteNode = graph.nodes.find(n => n.notePath === notePath);
		results.push({
			notePath,
			noteLabel: noteNode?.label ?? notePath,
			score: data.score,
			matchedEntities: [...new Set(data.entities)],
		});
	}

	return results.sort((a, b) => b.score - a.score);
}
