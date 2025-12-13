import { OntologyNode, OntologyEdge, OntologyExtractionResult, RelationshipType } from '../types';
import type { GraphCache } from './cache';
import type { App, TFile } from 'obsidian';
import { getResolvedLinks } from './links';

/**
 * Generate a unique node ID from label and name.
 * Uses lowercase normalized name for deduplication.
 */
export function generateNodeId(label: string, name: string): string {
	return `${label.toLowerCase()}:${name.toLowerCase().trim()}`;
}

/**
 * Generate a unique edge ID from source, target, and type.
 */
export function generateEdgeId(source: string, target: string, type: RelationshipType): string {
	return `${source}->${target}:${type}`;
}

/**
 * Normalize a node name for consistent matching.
 * Trims whitespace.
 */
export function normalizeName(name: string): string {
	return name.trim();
}

/**
 * Merge ontology extraction results into GraphCache.
 * Nodes are merged by label:name combination.
 * Edges are merged by source->target:type combination.
 */
export function mergeExtractionIntoCache(
	cache: GraphCache,
	notePath: string,
	extraction: OntologyExtractionResult
): { nodesAdded: number; relationshipsAdded: number } {
	const now = Date.now();
	let nodesAdded = 0;
	let relationshipsAdded = 0;

	// Map temporary extraction IDs to actual graph node IDs
	const idMap = new Map<string, string>();

	// Process nodes
	for (const rawNode of extraction.nodes) {
		const normalizedName = normalizeName(rawNode.properties.name);

		// First check if a node with the same name already exists (regardless of label)
		// This prevents duplicates like "concept:ai" vs "ai:ai"
		const existingByName = cache.getNodeByName(normalizedName);

		// Use existing node's ID if found, otherwise generate new ID
		const nodeId = existingByName
			? existingByName.id
			: generateNodeId(rawNode.label, normalizedName);
		idMap.set(rawNode.id, nodeId);

		const existing = existingByName || cache.getNodeById(nodeId);

		if (existing) {
			// Update existing node: add this note to sourceNotes if not already there
			if (!existing.sourceNotes.includes(notePath)) {
				existing.sourceNotes.push(notePath);
			}
			existing.updatedAt = now;
			// Merge additional properties (but don't overwrite name)
			for (const [key, value] of Object.entries(rawNode.properties)) {
				if (key !== 'name' && !(key in existing.properties)) {
					existing.properties[key] = value;
				}
			}
			cache.updateNode(existing);
		} else {
			// Create new node
			const newNode: OntologyNode = {
				id: nodeId,
				label: rawNode.label,
				properties: {
					name: normalizedName,
					...Object.fromEntries(
						Object.entries(rawNode.properties).filter(([k]: [string, unknown]) => k !== 'name')
					)
				},
				sourceNotes: [notePath],
				createdAt: now,
				updatedAt: now,
			};
			cache.addNode(newNode);
			nodesAdded++;
		}
	}

	// Process relationships
	for (const rawRel of extraction.relationships) {
		const sourceId = idMap.get(rawRel.source);
		const targetId = idMap.get(rawRel.target);

		// Only add if both source and target nodes exist
		if (!sourceId || !targetId) {
			console.warn(`Skipping relationship: missing node mapping for ${rawRel.source} -> ${rawRel.target}`);
			continue;
		}

		if (!cache.getNodeById(sourceId) || !cache.getNodeById(targetId)) {
			console.warn(`Skipping relationship: node not found ${sourceId} -> ${targetId}`);
			continue;
		}

		const edgeId = generateEdgeId(sourceId, targetId, rawRel.type);

		if (!cache.getEdgeById(edgeId)) {
			const newEdge: OntologyEdge = {
				id: edgeId,
				source: sourceId,
				target: targetId,
				type: rawRel.type,
				properties: {
					detail: rawRel.properties.detail,
					...Object.fromEntries(
						Object.entries(rawRel.properties).filter(([k]: [string, unknown]) => k !== 'detail')
					)
				},
				sourceNote: notePath,
				createdAt: now,
			};
			cache.addEdge(newEdge);
			relationshipsAdded++;
		}
	}

	return { nodesAdded, relationshipsAdded };
}

/**
 * Remove a note's contribution from the graph.
 * Removes the note from all nodes' sourceNotes arrays.
 * Removes nodes that have no remaining sourceNotes.
 * Removes edges that were created from this note.
 */
export function removeNoteFromCache(cache: GraphCache, notePath: string): { nodesRemoved: number; edgesRemoved: number } {
	let nodesRemoved = 0;
	let edgesRemoved = 0;

	// Find all edges created from this note and remove them
	const edgesToRemove: string[] = [];
	for (const edge of cache.getAllEdges()) {
		if (edge.sourceNote === notePath) {
			edgesToRemove.push(edge.id);
		}
	}

	for (const edgeId of edgesToRemove) {
		cache.removeEdge(edgeId);
		edgesRemoved++;
	}

	// Find all nodes that reference this note
	const nodesToCheck: string[] = [];
	for (const node of cache.getAllNodes()) {
		if (node.sourceNotes.includes(notePath)) {
			nodesToCheck.push(node.id);
		}
	}

	// Remove note from sourceNotes, delete node if orphaned
	for (const nodeId of nodesToCheck) {
		const node = cache.getNodeById(nodeId);
		if (!node) continue;

		node.sourceNotes = node.sourceNotes.filter(p => p !== notePath);

		if (node.sourceNotes.length === 0) {
			// Node is orphaned, remove it
			cache.removeNode(nodeId);
			nodesRemoved++;
		} else {
			// Update node with reduced sourceNotes
			cache.updateNode(node);
		}
	}

	return { nodesRemoved, edgesRemoved };
}

/**
 * Process internal links ([[wikilinks]]) and add RELATED_TO edges.
 * Links create edges between nodes that appear in both the source and target notes.
 * If the target note hasn't been analyzed, no edge is created.
 */
export function mergeInternalLinksIntoCache(
	cache: GraphCache,
	app: App,
	file: TFile,
	content: string
): number {
	const now = Date.now();
	const linkedPaths = getResolvedLinks(app, file, content);
	let linksAdded = 0;

	// Get all nodes from the source note
	const sourceNoteNodes = cache.getNodesBySourceNote(file.path);
	if (sourceNoteNodes.length === 0) {
		// Source note hasn't been analyzed yet
		return 0;
	}

	for (const targetPath of linkedPaths) {
		// Get all nodes from the target note
		const targetNoteNodes = cache.getNodesBySourceNote(targetPath);
		if (targetNoteNodes.length === 0) {
			// Target note hasn't been analyzed yet
			continue;
		}

		// Create RELATED_TO edges between nodes from source and target notes
		// We connect each source node to each target node (cross-product)
		// This represents the wikilink relationship at the entity level
		for (const sourceNode of sourceNoteNodes) {
			for (const targetNode of targetNoteNodes) {
				// Don't create self-loops
				if (sourceNode.id === targetNode.id) continue;

				const edgeId = generateEdgeId(sourceNode.id, targetNode.id, 'RELATED_TO');

				// Check if edge already exists (might have been created with different detail)
				if (!cache.getEdgeById(edgeId)) {
					cache.addEdge({
						id: edgeId,
						source: sourceNode.id,
						target: targetNode.id,
						type: 'RELATED_TO',
						properties: {
							detail: 'wikilink',
						},
						sourceNote: file.path,
						createdAt: now,
					});
					linksAdded++;
				}
			}
		}
	}

	return linksAdded;
}

/**
 * Get all unique node names from the graph.
 * Useful for providing context to LLM for name normalization.
 */
export function getExistingNodeNames(cache: GraphCache): string[] {
	return cache.getAllNodes().map(n => n.properties.name);
}
