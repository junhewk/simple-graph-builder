import { GraphData, GraphNode, GraphEdge, ExtractionResult, NodeType, EdgeType } from '../types';
import type { GraphCache } from './cache';
import type { App, TFile } from 'obsidian';
import { getResolvedLinks } from './links';

/**
 * Generate a unique node ID from type and label.
 * Uses lowercase normalized label for deduplication.
 */
export function generateNodeId(type: NodeType, label: string): string {
	return `${type}:${label.toLowerCase().trim()}`;
}

/**
 * Generate a unique edge ID from source, target, and type.
 */
export function generateEdgeId(source: string, target: string, type: EdgeType): string {
	return `${source}->${target}:${type}`;
}

/**
 * Normalize an entity label for consistent matching.
 * Trims whitespace and normalizes case.
 */
export function normalizeLabel(label: string): string {
	return label.trim();
}

/**
 * Merge extraction results into the graph.
 * Handles deduplication and updates existing nodes/edges.
 */
export function mergeExtractionResult(
	graph: GraphData,
	notePath: string,
	noteLabel: string,
	extraction: ExtractionResult
): GraphData {
	const now = Date.now();
	const newNodes: GraphNode[] = [...graph.nodes];
	const newEdges: GraphEdge[] = [...graph.edges];

	// Helper to find or create node
	const findOrCreateNode = (type: NodeType, label: string, extra?: Partial<GraphNode>): string => {
		const normalizedLabel = normalizeLabel(label);
		const id = generateNodeId(type, normalizedLabel);
		const existingIndex = newNodes.findIndex(n => n.id === id);

		if (existingIndex >= 0) {
			// Update existing node
			newNodes[existingIndex] = {
				...newNodes[existingIndex],
				updatedAt: now,
			};
		} else {
			// Create new node
			newNodes.push({
				id,
				type,
				label: normalizedLabel,
				createdAt: now,
				updatedAt: now,
				...extra,
			});
		}

		return id;
	};

	// Helper to find or create edge
	const findOrCreateEdge = (source: string, target: string, type: EdgeType): void => {
		const id = generateEdgeId(source, target, type);
		if (!newEdges.find(e => e.id === id)) {
			newEdges.push({
				id,
				source,
				target,
				type,
				createdAt: now,
			});
		}
	};

	// Add/update note node
	const noteId = findOrCreateNode('note', notePath, {
		label: noteLabel,
		notePath: notePath,
	});

	// Update the note node's label (in case file was renamed)
	const noteNode = newNodes.find(n => n.id === noteId);
	if (noteNode) {
		noteNode.label = noteLabel;
		noteNode.notePath = notePath;
	}

	// Add entity nodes and mentions edges
	const currentEntityIds = new Set<string>();
	for (const entity of extraction.entities) {
		const entityId = findOrCreateNode('entity', entity);
		currentEntityIds.add(entityId);
		findOrCreateEdge(noteId, entityId, 'mentions');
	}

	// Add keyword nodes and match edges
	const currentKeywordIds = new Set<string>();
	for (const keyword of extraction.keywordMatches) {
		const keywordId = findOrCreateNode('keyword', keyword);
		currentKeywordIds.add(keywordId);
		findOrCreateEdge(noteId, keywordId, 'matches_keyword');
	}

	// Add entity-to-entity relationships
	for (const rel of extraction.relationships) {
		const sourceId = generateNodeId('entity', normalizeLabel(rel.source));
		const targetId = generateNodeId('entity', normalizeLabel(rel.target));

		// Only add if both entities exist
		if (newNodes.find(n => n.id === sourceId) && newNodes.find(n => n.id === targetId)) {
			findOrCreateEdge(sourceId, targetId, 'relates_to');
		}
	}

	// Remove edges that no longer apply (entity was removed from note)
	const currentTargetIds = new Set([...currentEntityIds, ...currentKeywordIds]);
	const finalEdges = newEdges.filter(e => {
		// Keep edges not from this note
		if (e.source !== noteId) return true;
		// Keep edges to current targets
		if (currentTargetIds.has(e.target)) return true;
		// Keep relates_to edges (entity-to-entity)
		if (e.type === 'relates_to') return true;
		// Remove stale edges
		return false;
	});

	return {
		nodes: newNodes,
		edges: finalEdges,
		version: graph.version,
	};
}

/**
 * Get all unique entity labels from the graph.
 * Useful for providing context to LLM for entity normalization.
 */
export function getExistingEntityLabels(graph: GraphData): string[] {
	return graph.nodes
		.filter(n => n.type === 'entity')
		.map(n => n.label);
}

/**
 * Get all keyword labels from the graph.
 */
export function getKeywordLabels(graph: GraphData): string[] {
	return graph.nodes
		.filter(n => n.type === 'keyword')
		.map(n => n.label);
}

/**
 * Merge extraction results directly into GraphCache.
 * More efficient than mergeExtractionResult as it uses indexed lookups.
 */
export function mergeExtractionIntoCache(
	cache: GraphCache,
	notePath: string,
	noteLabel: string,
	extraction: ExtractionResult
): void {
	const now = Date.now();

	// Helper to find or create node in cache
	const findOrCreateNode = (type: NodeType, label: string, extra?: Partial<GraphNode>): string => {
		const normalizedLabel = normalizeLabel(label);
		const id = generateNodeId(type, normalizedLabel);
		const existing = cache.getNodeById(id);

		if (existing) {
			// Update existing node
			cache.addNode({ ...existing, updatedAt: now });
		} else {
			// Create new node
			cache.addNode({
				id,
				type,
				label: normalizedLabel,
				createdAt: now,
				updatedAt: now,
				...extra,
			});
		}

		return id;
	};

	// Helper to find or create edge in cache
	const findOrCreateEdge = (source: string, target: string, type: EdgeType): void => {
		const id = generateEdgeId(source, target, type);
		if (!cache.getEdgeById(id)) {
			cache.addEdge({
				id,
				source,
				target,
				type,
				createdAt: now,
			});
		}
	};

	// Add/update note node
	const noteId = findOrCreateNode('note', notePath, {
		label: noteLabel,
		notePath: notePath,
	});

	// Ensure label and path are correct (in case file was renamed)
	const noteNode = cache.getNodeById(noteId);
	if (noteNode) {
		cache.addNode({ ...noteNode, label: noteLabel, notePath: notePath });
	}

	// Track current targets for stale edge removal
	const currentEntityIds = new Set<string>();
	const currentKeywordIds = new Set<string>();

	// Add entity nodes and mentions edges
	for (const entity of extraction.entities) {
		const entityId = findOrCreateNode('entity', entity);
		currentEntityIds.add(entityId);
		findOrCreateEdge(noteId, entityId, 'mentions');
	}

	// Add keyword nodes and match edges
	for (const keyword of extraction.keywordMatches) {
		const keywordId = findOrCreateNode('keyword', keyword);
		currentKeywordIds.add(keywordId);
		findOrCreateEdge(noteId, keywordId, 'matches_keyword');
	}

	// Add entity-to-entity relationships
	for (const rel of extraction.relationships) {
		const sourceId = generateNodeId('entity', normalizeLabel(rel.source));
		const targetId = generateNodeId('entity', normalizeLabel(rel.target));

		// Only add if both entities exist
		if (cache.getNodeById(sourceId) && cache.getNodeById(targetId)) {
			findOrCreateEdge(sourceId, targetId, 'relates_to');
		}
	}

	// Remove stale edges (edges from this note to entities/keywords no longer extracted)
	const currentTargetIds = new Set([...currentEntityIds, ...currentKeywordIds]);
	const edgesToRemove: string[] = [];

	for (const edge of cache.getEdgesBySource(noteId)) {
		// Keep edges to current targets
		if (currentTargetIds.has(edge.target)) continue;
		// Keep relates_to edges (entity-to-entity, not from note)
		if (edge.type === 'relates_to') continue;
		// Keep links_to edges (handled separately by mergeInternalLinksIntoCache)
		if (edge.type === 'links_to') continue;
		// Mark stale edge for removal
		edgesToRemove.push(edge.id);
	}

	for (const edgeId of edgesToRemove) {
		cache.removeEdge(edgeId);
	}
}

/**
 * Process internal links ([[wikilinks]]) and add links_to edges between notes.
 * This should be called after mergeExtractionIntoCache or independently.
 */
export function mergeInternalLinksIntoCache(
	cache: GraphCache,
	app: App,
	file: TFile,
	content: string
): number {
	const now = Date.now();
	const linkedPaths = getResolvedLinks(app, file, content);

	// Get or create source note node
	const sourceNoteId = generateNodeId('note', file.path);
	let sourceNode = cache.getNodeById(sourceNoteId);

	if (!sourceNode) {
		// Create the source note node if it doesn't exist
		sourceNode = {
			id: sourceNoteId,
			type: 'note',
			label: file.basename,
			notePath: file.path,
			createdAt: now,
			updatedAt: now,
		};
		cache.addNode(sourceNode);
	}

	// Track current links for stale edge removal
	const currentLinkTargets = new Set<string>();
	let linksAdded = 0;

	for (const targetPath of linkedPaths) {
		const targetNoteId = generateNodeId('note', targetPath);
		currentLinkTargets.add(targetNoteId);

		// Get or create target note node
		let targetNode = cache.getNodeById(targetNoteId);
		if (!targetNode) {
			// Get the basename from the path
			const targetBasename = targetPath.replace(/\.md$/, '').split('/').pop() || targetPath;
			targetNode = {
				id: targetNoteId,
				type: 'note',
				label: targetBasename,
				notePath: targetPath,
				createdAt: now,
				updatedAt: now,
			};
			cache.addNode(targetNode);
		}

		// Create links_to edge if it doesn't exist
		const edgeId = generateEdgeId(sourceNoteId, targetNoteId, 'links_to');
		if (!cache.getEdgeById(edgeId)) {
			cache.addEdge({
				id: edgeId,
				source: sourceNoteId,
				target: targetNoteId,
				type: 'links_to',
				createdAt: now,
			});
			linksAdded++;
		}
	}

	// Remove stale links_to edges (links that were removed from the note)
	const edgesToRemove: string[] = [];
	for (const edge of cache.getEdgesBySource(sourceNoteId)) {
		if (edge.type !== 'links_to') continue;
		if (!currentLinkTargets.has(edge.target)) {
			edgesToRemove.push(edge.id);
		}
	}

	for (const edgeId of edgesToRemove) {
		cache.removeEdge(edgeId);
	}

	return linksAdded;
}
