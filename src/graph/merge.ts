import { OntologyNode, OntologyEdge, OntologyExtractionResult, RawExtractionRelationship, ResolutionStats, Settings, NOTE_ID_PREFIX, normalizeKey, normalizeUnicode } from '../types';
import type { GraphCache } from './cache';
import type { App, TFile } from 'obsidian';
import { getResolvedLinks, getResolvedLinksFromCache } from './links';
import { EntityResolver } from './resolver';

/**
 * Generate a unique node ID from entity type and name.
 * Uses lowercase normalized name for deduplication.
 */
export function generateNodeId(entityType: string, name: string): string {
	return `${entityType.toLowerCase()}:${normalizeKey(name)}`;
}

/**
 * Generate a unique edge ID from source, target, and relationship verb.
 */
export function generateEdgeId(source: string, target: string, relationship: string): string {
	return `${source}->${target}:${normalizeKey(relationship)}`;
}

/**
 * Normalize a node's display name. Keeps case, but fixes the Unicode form so
 * two encodings of the same Korean word can't become two nodes.
 */
export function normalizeName(name: string): string {
	return normalizeUnicode(name).trim();
}

/**
 * Process relationships and add edges to the cache.
 * Shared helper for both merge functions.
 */
function processRelationships(
	cache: GraphCache,
	relationships: RawExtractionRelationship[],
	idMap: Map<string, string>,
	notePath: string,
	now: number
): number {
	let relationshipsAdded = 0;

	for (const rawRel of relationships) {
		const sourceId = idMap.get(rawRel.source);
		const targetId = idMap.get(rawRel.target);

		if (!sourceId || !targetId) {
			console.warn(`Skipping relationship: missing node mapping for ${rawRel.source} -> ${rawRel.target}`);
			continue;
		}

		if (!cache.getNodeById(sourceId) || !cache.getNodeById(targetId)) {
			console.warn(`Skipping relationship: node not found ${sourceId} -> ${targetId}`);
			continue;
		}

		const relationship = rawRel.relationship || 'relates to';
		const edgeId = generateEdgeId(sourceId, targetId, relationship);

		if (!cache.getEdgeById(edgeId)) {
			const newEdge: OntologyEdge = {
				id: edgeId,
				source: sourceId,
				target: targetId,
				relationship: relationship,
				properties: {
					detail: rawRel.properties.detail,
					...Object.fromEntries(
						Object.entries(rawRel.properties).filter(([k]) => k !== 'detail')
					)
				},
				sourceNote: notePath,
				createdAt: now,
			};
			cache.addEdge(newEdge);
			relationshipsAdded++;
		}
	}

	return relationshipsAdded;
}

/**
 * Merge ontology extraction results into GraphCache.
 * Nodes are merged by entityType:name combination.
 * Edges are merged by source->target:relationship combination.
 */
export function mergeExtractionIntoCache(
	cache: GraphCache,
	notePath: string,
	extraction: OntologyExtractionResult
): { nodesAdded: number; relationshipsAdded: number } {
	const now = Date.now();
	let nodesAdded = 0;

	// Map temporary extraction IDs to actual graph node IDs
	const idMap = new Map<string, string>();

	// Process nodes
	for (const rawNode of extraction.nodes) {
		const normalizedName = normalizeName(rawNode.properties.name);

		// First check if a node with the same name already exists (regardless of entity type)
		const existingByName = cache.getNodeByName(normalizedName);

		// Use existing node's ID if found, otherwise generate new ID
		const nodeId = existingByName
			? existingByName.id
			: generateNodeId(rawNode.entityType, normalizedName);
		idMap.set(rawNode.id, nodeId);

		const existing = existingByName || cache.getNodeById(nodeId);

		if (existing) {
			// Update existing node
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
				entityType: rawNode.entityType,
				properties: {
					name: normalizedName,
					description: rawNode.properties.description,
					...Object.fromEntries(
						Object.entries(rawNode.properties).filter(([k]) => k !== 'name' && k !== 'description')
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
	const relationshipsAdded = processRelationships(cache, extraction.relationships, idMap, notePath, now);

	return { nodesAdded, relationshipsAdded };
}

/**
 * Extended merge result with resolution statistics.
 */
export interface MergeResultWithResolution {
	nodesAdded: number;
	nodesMerged: number;
	relationshipsAdded: number;
	resolutionStats: ResolutionStats;
}

/**
 * Merge ontology extraction results into GraphCache with entity resolution.
 * Uses the EntityResolver for intelligent entity matching when embeddings are enabled.
 */
export async function mergeExtractionIntoCacheWithResolution(
	cache: GraphCache,
	notePath: string,
	extraction: OntologyExtractionResult,
	settings: Settings
): Promise<MergeResultWithResolution> {
	const now = Date.now();
	let nodesAdded = 0;
	let nodesMerged = 0;

	// Create resolver for this session
	const resolver = new EntityResolver(cache, settings);

	// Resolve all nodes in batch
	const resolutionResults = await resolver.resolveBatch(extraction.nodes);

	// Map temporary extraction IDs to actual graph node IDs
	const idMap = new Map<string, string>();

	// Process nodes with resolution results
	for (const rawNode of extraction.nodes) {
		const resolution = resolutionResults.get(rawNode.id);
		if (!resolution) {
			console.warn(`No resolution result for node ${rawNode.id}`);
			continue;
		}

		const nodeId = resolution.nodeId;
		idMap.set(rawNode.id, nodeId);

		const existing = cache.getNodeById(nodeId);

		if (existing) {
			// Merged with existing node
			if (!existing.sourceNotes.includes(notePath)) {
				existing.sourceNotes.push(notePath);
			}
			existing.updatedAt = now;

			// Merge additional properties (but don't overwrite name or aliases)
			for (const [key, value] of Object.entries(rawNode.properties)) {
				if (key !== 'name' && key !== 'aliases' && !(key in existing.properties)) {
					existing.properties[key] = value;
				}
			}

			cache.updateNode(existing);

			if (resolution.matchType !== 'exact') {
				nodesMerged++;
			}
		} else {
			// Create new node
			const normalizedName = normalizeName(rawNode.properties.name);
			const newNode: OntologyNode = {
				id: nodeId,
				entityType: rawNode.entityType,
				properties: {
					name: normalizedName,
					description: rawNode.properties.description,
					...Object.fromEntries(
						Object.entries(rawNode.properties).filter(([k]) => k !== 'name' && k !== 'description')
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
	const relationshipsAdded = processRelationships(cache, extraction.relationships, idMap, notePath, now);

	return {
		nodesAdded,
		nodesMerged,
		relationshipsAdded,
		resolutionStats: resolver.getStats(),
	};
}

/**
 * Remove a note's contribution from the graph.
 */
export function removeNoteFromCache(cache: GraphCache, notePath: string): { nodesRemoved: number; edgesRemoved: number } {
	let nodesRemoved = 0;
	let edgesRemoved = 0;

	// Use index to find edges from this note
	const edgesToRemove = cache.getEdgesBySourceNote(notePath);
	for (const edge of edgesToRemove) {
		cache.removeEdge(edge.id);
		edgesRemoved++;
	}

	// Use index to find nodes from this note
	const nodesToCheck = cache.getNodesBySourceNote(notePath);
	for (const node of nodesToCheck) {
		node.sourceNotes = node.sourceNotes.filter(p => p !== notePath);

		if (node.sourceNotes.length === 0) {
			cache.removeNode(node.id);
			nodesRemoved++;
		} else {
			cache.updateNode(node);
		}
	}

	return { nodesRemoved, edgesRemoved };
}

/**
 * Generate the node ID for a vault note.
 *
 * Keyed on the full path, not the basename: two notes in different folders can
 * share a basename, and collapsing them would silently merge their link graphs.
 */
export function generateNoteNodeId(notePath: string): string {
	return `${NOTE_ID_PREFIX}${normalizeKey(notePath)}`;
}

/**
 * Ensure a note has a NOTE node, returning its id.
 */
function ensureNoteNode(cache: GraphCache, notePath: string, now: number): string {
	const id = generateNoteNodeId(notePath);
	if (cache.getNodeById(id)) return id;

	const basename = notePath.split('/').pop()?.replace(/\.md$/i, '') ?? notePath;
	cache.addNode({
		id,
		entityType: 'NOTE',
		properties: { name: basename, path: notePath },
		sourceNotes: [notePath],
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/**
 * Build the note layer for a single note: a NOTE node, `mentions` edges to the
 * entities extracted from it, and `links to` edges to the notes it wikilinks.
 *
 * Replaces the old entity-level cross product (see isLegacyWikilinkEdge). Cost
 * is O(L + k) per note instead of O(L*k^2), and the note-to-note edge is what
 * CLAUDE.md described in the first place.
 *
 * Link targets that have never been analyzed are skipped, matching the previous
 * behaviour — the graph shouldn't sprout nodes for notes it knows nothing about.
 */
export function mergeNoteLayerIntoCache(
	cache: GraphCache,
	app: App,
	file: TFile,
	content: string
): number {
	const now = Date.now();

	const entityNodes = cache.getNodesBySourceNote(file.path)
		.filter(n => n.entityType !== 'NOTE');
	if (entityNodes.length === 0) {
		return 0;
	}

	const noteId = ensureNoteNode(cache, file.path, now);
	let edgesAdded = 0;

	// note -> entity
	for (const entity of entityNodes) {
		const edgeId = generateEdgeId(noteId, entity.id, 'mentions');
		if (!cache.getEdgeById(edgeId)) {
			cache.addEdge({
				id: edgeId,
				source: noteId,
				target: entity.id,
				relationship: 'mentions',
				properties: {},
				sourceNote: file.path,
				createdAt: now,
			});
			edgesAdded++;
		}
	}

	// note -> note
	for (const targetPath of getResolvedLinks(app, file, content)) {
		if (targetPath === file.path) continue;
		const targetHasEntities = cache.getNodesBySourceNote(targetPath)
			.some(n => n.entityType !== 'NOTE');
		if (!targetHasEntities) continue;

		const targetId = ensureNoteNode(cache, targetPath, now);
		if (targetId === noteId) continue;

		const edgeId = generateEdgeId(noteId, targetId, 'links to');
		if (!cache.getEdgeById(edgeId)) {
			cache.addEdge({
				id: edgeId,
				source: noteId,
				target: targetId,
				relationship: 'links to',
				properties: {},
				sourceNote: file.path,
				createdAt: now,
			});
			edgesAdded++;
		}
	}

	return edgesAdded;
}

/**
 * Rebuild the whole note layer from data already on disk, with no LLM calls and
 * no file reads.
 *
 * Everything needed is already available: which entities came from which note
 * lives in each node's `sourceNotes`, and the vault's link graph lives in
 * Obsidian's `metadataCache.resolvedLinks`. That makes it possible to repair a
 * graph damaged by the old cross-product pass without asking the user to
 * re-analyze their vault.
 *
 * Requires a populated metadata cache — call from `workspace.onLayoutReady`.
 */
export function rebuildNoteLayer(
	cache: GraphCache,
	app: App
): { noteNodesAdded: number; edgesAdded: number } {
	const now = Date.now();

	// Which notes contributed entities? Derived from the nodes themselves, so
	// this works even when the hash index has been cleared.
	const notePaths = new Set<string>();
	for (const node of cache.getAllNodes()) {
		if (node.entityType === 'NOTE') continue;
		for (const path of node.sourceNotes) notePaths.add(path);
	}

	let noteNodesAdded = 0;
	let edgesAdded = 0;

	for (const path of notePaths) {
		if (!cache.getNodeById(generateNoteNodeId(path))) noteNodesAdded++;
		const noteId = ensureNoteNode(cache, path, now);

		for (const entity of cache.getNodesBySourceNote(path)) {
			if (entity.entityType === 'NOTE') continue;
			const edgeId = generateEdgeId(noteId, entity.id, 'mentions');
			if (!cache.getEdgeById(edgeId)) {
				cache.addEdge({
					id: edgeId,
					source: noteId,
					target: entity.id,
					relationship: 'mentions',
					properties: {},
					sourceNote: path,
					createdAt: now,
				});
				edgesAdded++;
			}
		}
	}

	for (const path of notePaths) {
		const noteId = generateNoteNodeId(path);
		for (const targetPath of getResolvedLinksFromCache(app, path)) {
			if (!notePaths.has(targetPath)) continue;
			const targetId = generateNoteNodeId(targetPath);
			if (targetId === noteId) continue;

			const edgeId = generateEdgeId(noteId, targetId, 'links to');
			if (!cache.getEdgeById(edgeId)) {
				cache.addEdge({
					id: edgeId,
					source: noteId,
					target: targetId,
					relationship: 'links to',
					properties: {},
					sourceNote: path,
					createdAt: now,
				});
				edgesAdded++;
			}
		}
	}

	return { noteNodesAdded, edgesAdded };
}

/**
 * Get all unique node names from the graph.
 */
export function getExistingNodeNames(cache: GraphCache): string[] {
	return cache.getAllNodes().map(n => n.properties.name);
}
