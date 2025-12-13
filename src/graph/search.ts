import { GraphData, OntologyNode } from '../types';
import type { GraphCache } from './cache';

export interface SearchResult {
	nodeName: string;
	nodeLabel: string;
	sourceNotes: string[];
	score: number;
	matchedOn: 'name' | 'label';
}

export interface SearchOptions {
	exactMatch?: boolean;
	labelFilter?: string;
}

/**
 * Search graph using GraphCache (O(1) lookups via indexes).
 * Searches nodes by name and optionally filters by label.
 */
export function searchGraphCache(cache: GraphCache, query: string, options?: SearchOptions): SearchResult[] {
	const queryLower = query.toLowerCase().trim();
	if (!queryLower) return [];

	const exactMatch = options?.exactMatch ?? false;
	const labelFilter = options?.labelFilter;

	const results: SearchResult[] = [];

	for (const node of cache.getAllNodes()) {
		// Apply label filter if specified
		if (labelFilter && node.label !== labelFilter) {
			continue;
		}

		const nameLower = node.properties.name.toLowerCase();
		const labelLower = node.label.toLowerCase();

		let score = 0;
		let matchedOn: 'name' | 'label' = 'name';

		if (exactMatch) {
			// Exact match: name must equal query exactly
			if (nameLower === queryLower) {
				score = 1.0;
				matchedOn = 'name';
			}
		} else {
			// Fuzzy match: substring matching
			if (nameLower === queryLower) {
				// Exact name match
				score = 1.0;
				matchedOn = 'name';
			} else if (nameLower.includes(queryLower)) {
				// Name contains query
				score = queryLower.length / nameLower.length;
				matchedOn = 'name';
			} else if (queryLower.includes(nameLower)) {
				// Query contains name
				score = nameLower.length / queryLower.length * 0.8;
				matchedOn = 'name';
			} else if (labelLower.includes(queryLower) || queryLower.includes(labelLower)) {
				// Label match (lower priority)
				score = 0.3;
				matchedOn = 'label';
			}
		}

		if (score > 0) {
			results.push({
				nodeName: node.properties.name,
				nodeLabel: node.label,
				sourceNotes: [...node.sourceNotes],
				score,
				matchedOn,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Search graph using raw GraphData (for backwards compatibility).
 * @deprecated Use searchGraphCache for better performance.
 */
export function searchGraph(graph: GraphData, query: string, options?: SearchOptions): SearchResult[] {
	const queryLower = query.toLowerCase().trim();
	if (!queryLower) return [];

	const exactMatch = options?.exactMatch ?? false;
	const labelFilter = options?.labelFilter;

	const results: SearchResult[] = [];

	for (const node of graph.nodes) {
		// Apply label filter if specified
		if (labelFilter && node.label !== labelFilter) {
			continue;
		}

		const nameLower = node.properties.name.toLowerCase();
		const labelLower = node.label.toLowerCase();

		let score = 0;
		let matchedOn: 'name' | 'label' = 'name';

		if (exactMatch) {
			if (nameLower === queryLower) {
				score = 1.0;
				matchedOn = 'name';
			}
		} else {
			if (nameLower === queryLower) {
				score = 1.0;
				matchedOn = 'name';
			} else if (nameLower.includes(queryLower)) {
				score = queryLower.length / nameLower.length;
				matchedOn = 'name';
			} else if (queryLower.includes(nameLower)) {
				score = nameLower.length / queryLower.length * 0.8;
				matchedOn = 'name';
			} else if (labelLower.includes(queryLower) || queryLower.includes(labelLower)) {
				score = 0.3;
				matchedOn = 'label';
			}
		}

		if (score > 0) {
			results.push({
				nodeName: node.properties.name,
				nodeLabel: node.label,
				sourceNotes: [...node.sourceNotes],
				score,
				matchedOn,
			});
		}
	}

	return results.sort((a, b) => b.score - a.score);
}

/**
 * Get nodes connected to a given node (1-hop).
 */
export function getConnectedNodesFromCache(cache: GraphCache, nodeName: string): OntologyNode[] {
	const node = cache.getNodeByName(nodeName);
	if (!node) return [];
	return cache.getConnectedNodes(node.id);
}

/**
 * Get source notes for a node by name.
 */
export function getSourceNotesForNode(cache: GraphCache, nodeName: string): string[] {
	const node = cache.getNodeByName(nodeName);
	return node ? [...node.sourceNotes] : [];
}
