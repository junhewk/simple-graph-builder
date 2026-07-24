import { Notice } from 'obsidian';
import { GraphData, OntologyNode, OntologyEdge, PluginData, GRAPH_SCHEMA_VERSION, isLegacyGraphData, ResolutionCache, EmbeddingIndex, labelToEntityType } from '../types';
import { DEFAULT_SETTINGS, DEFAULT_EMBEDDING_DIMENSIONS, getEmbeddingDimensions } from '../settings';
import { loadEmbeddingsBinary, saveEmbeddingsBinary, cosineSimilarity } from '../extraction/llm-client';
import type SimpleGraphBuilderPlugin from '../main';

const SAVE_DEBOUNCE_MS = 1000;

/**
 * GraphCache provides O(1) lookups via Maps and debounced persistence.
 * Updated for ontology model (v2) with flexible node labels and fixed relationship types.
 */
export class GraphCache {
	private plugin: SimpleGraphBuilderPlugin;
	private loaded = false;
	private dirty = false;
	private saveTimeout: number | null = null;

	// Raw data
	private nodes: OntologyNode[] = [];
	private edges: OntologyEdge[] = [];
	private version = GRAPH_SCHEMA_VERSION;

	// Indexes for O(1) lookups
	private nodeById: Map<string, OntologyNode> = new Map();
	private nodesByEntityType: Map<string, OntologyNode[]> = new Map();
	private nodesByLabel: Map<string, OntologyNode[]> = new Map(); // Legacy
	private nodesBySourceNote: Map<string, OntologyNode[]> = new Map();
	private nodeByName: Map<string, OntologyNode> = new Map(); // lowercase name -> node
	private nodeByAlias: Map<string, OntologyNode> = new Map(); // lowercase alias -> node
	private edgeById: Map<string, OntologyEdge> = new Map();
	private edgesBySource: Map<string, OntologyEdge[]> = new Map();
	private edgesByTarget: Map<string, OntologyEdge[]> = new Map();
	private edgesBySourceNote: Map<string, OntologyEdge[]> = new Map();

	// Resolution cache (persistent across sessions)
	private resolutionCache: Map<string, string> = new Map(); // lowercase token -> node ID
	private resolutionCacheDirty = false;

	// Embeddings (lazy loaded from binary file)
	private embeddings: Map<string, Float32Array> = new Map(); // node ID -> embedding
	private embeddingsLoaded = false;
	private embeddingsDirty = false;
	private embeddingIndex: EmbeddingIndex | null = null;

	constructor(plugin: SimpleGraphBuilderPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Ensure graph is loaded into memory. Idempotent.
	 * Handles v1 -> v2 migration by clearing data.
	 */
	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;

		const data: PluginData | null = await this.plugin.loadData();
		const graph = data?.graph;

		if (graph) {
			// Check for legacy v1 data
			if (isLegacyGraphData(graph)) {
				console.debug('Detected legacy v1 graph data. Clearing for v2 schema.');
				this.nodes = [];
				this.edges = [];
				this.version = GRAPH_SCHEMA_VERSION;
				// Clear hashes to allow re-analysis
				if (data.hashes) {
					data.hashes.hashes = [];
				}
				this.dirty = true;
			} else {
				this.nodes = graph.nodes || [];
				this.edges = graph.edges || [];
				this.version = graph.version || GRAPH_SCHEMA_VERSION;
			}
		} else {
			this.nodes = [];
			this.edges = [];
			this.version = GRAPH_SCHEMA_VERSION;
		}

		// Migrate v2 -> v3 schema (populate entityType and relationship)
		this.migrateToV3();

		// Load resolution cache
		if (data?.resolutionCache) {
			for (const [token, nodeId] of Object.entries(data.resolutionCache)) {
				this.resolutionCache.set(token, nodeId);
			}
		}

		// Load embedding index (embeddings are loaded lazily)
		this.embeddingIndex = data?.embeddingIndex || null;

		this.rebuildIndexes();
		this.loaded = true;
	}

	/**
	 * Check if legacy data was detected and cleared.
	 */
	wasLegacyDataCleared(): boolean {
		return this.dirty && this.nodes.length === 0;
	}

	/**
	 * Migrate v2 data to v3 schema:
	 * - Nodes: populate entityType from label
	 * - Edges: populate relationship from type
	 */
	private migrateToV3(): void {
		let migrated = false;

		// Migrate nodes: populate entityType from label if missing
		for (const node of this.nodes) {
			if (!node.entityType && node.label) {
				node.entityType = labelToEntityType(node.label);
				migrated = true;
			} else if (!node.entityType) {
				node.entityType = 'CONCEPT';
				migrated = true;
			}
		}

		// Migrate edges: populate relationship from type if missing
		// Legacy type to verb mapping (inline to avoid deprecated imports)
		const legacyTypeToVerb: Record<string, string> = {
			'HAS_PART': 'contains',
			'LEADS_TO': 'leads to',
			'ACTED_ON': 'acts on',
			'CITES': 'cites',
			'RELATED_TO': 'relates to',
		};
		for (const edge of this.edges) {
			if (!edge.relationship && edge.type) {
				const edgeType = edge.type;
				const verb = legacyTypeToVerb[edgeType];
				if (verb) {
					edge.relationship = verb;
				} else {
					edge.relationship = String(edgeType).toLowerCase().replace(/_/g, ' ');
				}
				migrated = true;
			} else if (!edge.relationship) {
				edge.relationship = 'relates to';
				migrated = true;
			}
		}

		if (migrated) {
			console.debug('Migrated graph data from v2 to v3 schema');
			this.dirty = true;
		}
	}

	/**
	 * Rebuild all indexes from raw arrays.
	 */
	private rebuildIndexes(): void {
		this.nodeById.clear();
		this.nodesByEntityType.clear();
		this.nodesByLabel.clear();
		this.nodesBySourceNote.clear();
		this.nodeByName.clear();
		this.nodeByAlias.clear();
		this.edgeById.clear();
		this.edgesBySource.clear();
		this.edgesByTarget.clear();
		this.edgesBySourceNote.clear();

		for (const node of this.nodes) {
			this.indexNode(node);
		}

		for (const edge of this.edges) {
			this.indexEdge(edge);
		}
	}

	/**
	 * Add node to a map index, creating the array if needed.
	 */
	private addToMapIndex(map: Map<string, OntologyNode[]>, key: string, node: OntologyNode): void {
		const arr = map.get(key);
		if (arr) {
			arr.push(node);
		} else {
			map.set(key, [node]);
		}
	}

	/**
	 * Add a node to all indexes.
	 */
	private indexNode(node: OntologyNode): void {
		this.nodeById.set(node.id, node);

		// Index by entity type
		const entityType = node.entityType || 'CONCEPT';
		this.addToMapIndex(this.nodesByEntityType, entityType, node);

		// Index by label (legacy support)
		const label = node.label || entityType;
		this.addToMapIndex(this.nodesByLabel, label, node);

		// Index by source notes
		for (const notePath of node.sourceNotes) {
			this.addToMapIndex(this.nodesBySourceNote, notePath, node);
		}

		// Index by name (lowercase for case-insensitive lookup)
		this.nodeByName.set(node.properties.name.toLowerCase(), node);

		// Index by aliases
		const aliases = node.properties.aliases;
		if (aliases && Array.isArray(aliases)) {
			for (const alias of aliases) {
				if (typeof alias === 'string') {
					this.nodeByAlias.set(alias.toLowerCase(), node);
				}
			}
		}
	}

	/**
	 * Remove a node from all indexes.
	 */
	private unindexNode(node: OntologyNode): void {
		this.nodeById.delete(node.id);
		this.nodeByName.delete(node.properties.name.toLowerCase());

		// Remove from alias index
		const aliases = node.properties.aliases;
		if (aliases && Array.isArray(aliases)) {
			for (const alias of aliases) {
				if (typeof alias === 'string') {
					this.nodeByAlias.delete(alias.toLowerCase());
				}
			}
		}

		// Remove from entity type index
		const entityType = node.entityType || 'CONCEPT';
		const entityTypeArr = this.nodesByEntityType.get(entityType);
		if (entityTypeArr) {
			const idx = entityTypeArr.indexOf(node);
			if (idx >= 0) entityTypeArr.splice(idx, 1);
		}

		// Remove from label index (legacy support)
		const label = node.label || entityType;
		const labelArr = this.nodesByLabel.get(label);
		if (labelArr) {
			const idx = labelArr.indexOf(node);
			if (idx >= 0) labelArr.splice(idx, 1);
		}

		// Remove from source note indexes
		for (const notePath of node.sourceNotes) {
			const noteArr = this.nodesBySourceNote.get(notePath);
			if (noteArr) {
				const idx = noteArr.indexOf(node);
				if (idx >= 0) noteArr.splice(idx, 1);
			}
		}
	}

	/**
	 * Add edge to a map index, creating the array if needed.
	 */
	private addEdgeToMapIndex(map: Map<string, OntologyEdge[]>, key: string, edge: OntologyEdge): void {
		const arr = map.get(key);
		if (arr) {
			arr.push(edge);
		} else {
			map.set(key, [edge]);
		}
	}

	/**
	 * Add an edge to all indexes.
	 */
	private indexEdge(edge: OntologyEdge): void {
		this.edgeById.set(edge.id, edge);
		this.addEdgeToMapIndex(this.edgesBySource, edge.source, edge);
		this.addEdgeToMapIndex(this.edgesByTarget, edge.target, edge);

		if (edge.sourceNote) {
			this.addEdgeToMapIndex(this.edgesBySourceNote, edge.sourceNote, edge);
		}
	}

	/**
	 * Remove an edge from all indexes.
	 */
	private unindexEdge(edge: OntologyEdge): void {
		this.edgeById.delete(edge.id);

		const sourceArr = this.edgesBySource.get(edge.source);
		if (sourceArr) {
			const idx = sourceArr.indexOf(edge);
			if (idx >= 0) sourceArr.splice(idx, 1);
		}

		const targetArr = this.edgesByTarget.get(edge.target);
		if (targetArr) {
			const idx = targetArr.indexOf(edge);
			if (idx >= 0) targetArr.splice(idx, 1);
		}

		if (edge.sourceNote) {
			const noteArr = this.edgesBySourceNote.get(edge.sourceNote);
			if (noteArr) {
				const idx = noteArr.indexOf(edge);
				if (idx >= 0) noteArr.splice(idx, 1);
			}
		}
	}

	/**
	 * Get the full graph data (for Cytoscape, etc.)
	 */
	getGraphData(): GraphData {
		return {
			nodes: [...this.nodes],
			edges: [...this.edges],
			version: this.version,
		};
	}

	// --- Node operations (O(1) lookups) ---

	getNodeById(id: string): OntologyNode | undefined {
		return this.nodeById.get(id);
	}

	getNodesByEntityType(entityType: string): OntologyNode[] {
		return this.nodesByEntityType.get(entityType) || [];
	}

	getNodesByLabel(label: string): OntologyNode[] {
		return this.nodesByLabel.get(label) || [];
	}

	getNodesBySourceNote(notePath: string): OntologyNode[] {
		return this.nodesBySourceNote.get(notePath) || [];
	}

	getNodeByName(name: string): OntologyNode | undefined {
		return this.nodeByName.get(name.toLowerCase());
	}

	/**
	 * Get node by alias (O(1) lookup).
	 */
	getNodeByAlias(alias: string): OntologyNode | undefined {
		return this.nodeByAlias.get(alias.toLowerCase());
	}

	/**
	 * Get node by name or alias (O(1) lookup).
	 * Checks exact name first, then aliases.
	 */
	getNodeByNameOrAlias(nameOrAlias: string): OntologyNode | undefined {
		const lower = nameOrAlias.toLowerCase();
		return this.nodeByName.get(lower) || this.nodeByAlias.get(lower);
	}

	/**
	 * Add an alias to an existing node.
	 */
	addAliasToNode(nodeId: string, alias: string): boolean {
		const node = this.nodeById.get(nodeId);
		if (!node) return false;

		const lowerAlias = alias.toLowerCase();

		// Don't add if it's the same as the node's name
		if (lowerAlias === node.properties.name.toLowerCase()) return false;

		// Don't add if alias already exists on this node
		const existingAliases = node.properties.aliases || [];
		if (existingAliases.some(a => a.toLowerCase() === lowerAlias)) return false;

		// Don't add if alias belongs to another node
		const existingNode = this.nodeByAlias.get(lowerAlias) || this.nodeByName.get(lowerAlias);
		if (existingNode && existingNode.id !== nodeId) return false;

		// Add alias
		if (!node.properties.aliases) {
			node.properties.aliases = [];
		}
		node.properties.aliases.push(alias);
		this.nodeByAlias.set(lowerAlias, node);
		node.updatedAt = Date.now();

		this.markDirty();
		return true;
	}

	getAllNodes(): OntologyNode[] {
		return [...this.nodes];
	}

	/**
	 * Get all unique entity types in the graph.
	 */
	getAllEntityTypes(): string[] {
		return Array.from(this.nodesByEntityType.keys());
	}

	/**
	 * Get all unique labels in the graph (legacy support).
	 */
	getAllLabels(): string[] {
		return Array.from(this.nodesByLabel.keys());
	}

	/**
	 * Get all unique node names (for LLM context).
	 */
	getExistingNodeNames(): string[] {
		return this.nodes.map(n => n.properties.name);
	}

	addNode(node: OntologyNode): void {
		if (this.nodeById.has(node.id)) {
			// Update existing - remove from indexes first
			const existing = this.nodeById.get(node.id)!;
			this.unindexNode(existing);
			const idx = this.nodes.indexOf(existing);
			if (idx >= 0) this.nodes.splice(idx, 1);
		}

		this.nodes.push(node);
		this.indexNode(node);
		this.markDirty();
	}

	/**
	 * Update an existing node (re-indexes it).
	 */
	updateNode(node: OntologyNode): void {
		if (!this.nodeById.has(node.id)) {
			// Node doesn't exist, add it
			this.addNode(node);
			return;
		}

		const existing = this.nodeById.get(node.id)!;
		this.unindexNode(existing);

		// Update in place
		Object.assign(existing, node);

		this.indexNode(existing);
		this.markDirty();
	}

	removeNode(id: string): boolean {
		const node = this.nodeById.get(id);
		if (!node) return false;

		// Remove from array
		const idx = this.nodes.indexOf(node);
		if (idx >= 0) this.nodes.splice(idx, 1);

		// Remove from indexes
		this.unindexNode(node);

		// Remove connected edges
		this.removeEdgesByNode(id);

		this.markDirty();
		return true;
	}

	// --- Edge operations (O(1) lookups) ---

	getEdgeById(id: string): OntologyEdge | undefined {
		return this.edgeById.get(id);
	}

	getEdgesBySource(sourceId: string): OntologyEdge[] {
		return this.edgesBySource.get(sourceId) || [];
	}

	getEdgesByTarget(targetId: string): OntologyEdge[] {
		return this.edgesByTarget.get(targetId) || [];
	}

	getEdgesBySourceNote(notePath: string): OntologyEdge[] {
		return this.edgesBySourceNote.get(notePath) || [];
	}

	getAllEdges(): OntologyEdge[] {
		return [...this.edges];
	}

	/**
	 * Get all edges connected to a node (both directions).
	 */
	getConnectedEdges(nodeId: string): OntologyEdge[] {
		const sourceEdges = this.edgesBySource.get(nodeId) || [];
		const targetEdges = this.edgesByTarget.get(nodeId) || [];
		return [...sourceEdges, ...targetEdges];
	}

	addEdge(edge: OntologyEdge): void {
		if (this.edgeById.has(edge.id)) return; // Already exists

		this.edges.push(edge);
		this.indexEdge(edge);
		this.markDirty();
	}

	removeEdge(id: string): boolean {
		const edge = this.edgeById.get(id);
		if (!edge) return false;

		// Remove from array
		const idx = this.edges.indexOf(edge);
		if (idx >= 0) this.edges.splice(idx, 1);

		// Remove from indexes
		this.unindexEdge(edge);

		this.markDirty();
		return true;
	}

	private removeEdgesByNode(nodeId: string): void {
		const toRemove: string[] = [];

		for (const edge of this.edges) {
			if (edge.source === nodeId || edge.target === nodeId) {
				toRemove.push(edge.id);
			}
		}

		for (const id of toRemove) {
			this.removeEdge(id);
		}
	}

	// --- Graph traversal ---

	getConnectedNodes(nodeId: string): OntologyNode[] {
		const connectedIds = new Set<string>();

		for (const edge of this.getEdgesBySource(nodeId)) {
			connectedIds.add(edge.target);
		}
		for (const edge of this.getEdgesByTarget(nodeId)) {
			connectedIds.add(edge.source);
		}

		const result: OntologyNode[] = [];
		for (const id of connectedIds) {
			const node = this.nodeById.get(id);
			if (node) result.push(node);
		}
		return result;
	}

	// --- Resolution Cache ---

	/**
	 * Get the resolved node ID for a token from persistent cache.
	 * Returns undefined if not cached.
	 */
	getResolvedNodeId(token: string): string | undefined {
		return this.resolutionCache.get(token.toLowerCase());
	}

	/**
	 * Cache a resolution decision (token -> node ID).
	 * This persists across sessions.
	 */
	cacheResolution(token: string, nodeId: string): void {
		this.resolutionCache.set(token.toLowerCase(), nodeId);
		this.resolutionCacheDirty = true;
		this.scheduleSave();
	}

	/**
	 * Remove a resolution from the cache.
	 */
	uncacheResolution(token: string): void {
		if (this.resolutionCache.delete(token.toLowerCase())) {
			this.resolutionCacheDirty = true;
			this.scheduleSave();
		}
	}

	/**
	 * Clear all resolution cache entries.
	 */
	clearResolutionCache(): void {
		this.resolutionCache.clear();
		this.resolutionCacheDirty = true;
		this.scheduleSave();
	}

	/**
	 * Get the number of entries in the resolution cache.
	 */
	getResolutionCacheSize(): number {
		return this.resolutionCache.size;
	}

	// --- Embeddings ---

	/**
	 * Load embeddings from binary file if not already loaded.
	 */
	async ensureEmbeddingsLoaded(): Promise<void> {
		if (this.embeddingsLoaded) return;

		// Load embedding index from plugin data
		const data: PluginData | null = await this.plugin.loadData();
		this.embeddingIndex = data?.embeddingIndex || null;

		if (!this.embeddingIndex || this.embeddingIndex.nodeIds.length === 0) {
			this.embeddingsLoaded = true;
			return;
		}

		// Stored vectors belong to whichever model produced them. Mixing widths
		// is silently destructive — saveEmbeddingsBinary writes through
		// TypedArray.set, which zero-pads a shorter source, and cosineSimilarity
		// throws on any length mismatch — so discard rather than mix.
		//
		// The model name is the reliable signal: it is recorded in the index and
		// works for custom or self-hosted models the dimension catalogue has
		// never heard of. The width check is a backstop for an index written
		// before the model was recorded.
		const settings = this.plugin.settings;
		const storedModel = this.embeddingIndex.model;
		const catalogueDimensions = getEmbeddingDimensions(
			settings.embeddingProvider,
			settings.embeddingModel
		);
		const inCatalogue = settings.embeddingModel
			? catalogueDimensions !== DEFAULT_EMBEDDING_DIMENSIONS ||
				settings.embeddingModel === 'text-embedding-3-small'
			: false;

		const modelChanged = !!storedModel && storedModel !== settings.embeddingModel;
		const widthChanged = inCatalogue && this.embeddingIndex.dimensions !== catalogueDimensions;

		if (modelChanged || widthChanged) {
			console.warn(
				`[simple-graph-builder] Stored embeddings came from "${storedModel ?? 'unknown'}" ` +
					`(${this.embeddingIndex.dimensions} dims) but the configured model is ` +
					`"${settings.embeddingModel}". Discarding the stale index.`
			);
			new Notice(
				'Embedding model changed. Recompute embeddings in settings to re-enable entity resolution.',
				8000
			);
			this.embeddingIndex = null;
			this.embeddings.clear();
			this.embeddingsLoaded = true;
			return;
		}

		// Load embeddings from binary file
		const pluginDir = this.plugin.manifest.dir || '';
		this.embeddings = await loadEmbeddingsBinary(
			this.plugin.app.vault,
			pluginDir,
			this.embeddingIndex.nodeIds,
			this.embeddingIndex.dimensions
		);

		this.embeddingsLoaded = true;
	}

	/**
	 * Save embeddings to binary file.
	 * Note: The embedding index is saved as part of flush(), not here.
	 */
	async saveEmbeddings(): Promise<void> {
		if (!this.embeddingsDirty) return;

		const settings = this.plugin.settings;

		// Build ordered list of node IDs
		const nodeIds = Array.from(this.embeddings.keys());

		// Take the width from the vectors themselves rather than the model
		// catalogue. A custom or self-hosted embedding model is not in the
		// catalogue, and the catalogue's fallback width would be wrong — which
		// saveEmbeddingsBinary now (correctly) refuses to write.
		const firstVector = this.embeddings.values().next().value as Float32Array | undefined;
		const dimensions =
			firstVector?.length ??
			getEmbeddingDimensions(settings.embeddingProvider, settings.embeddingModel);

		// Update embedding index (will be saved by flush())
		this.embeddingIndex = {
			nodeIds,
			model: settings.embeddingModel,
			dimensions,
			updatedAt: Date.now(),
		};

		// Save binary file only
		const pluginDir = this.plugin.manifest.dir || '';
		await saveEmbeddingsBinary(
			this.plugin.app.vault,
			pluginDir,
			this.embeddings,
			nodeIds,
			dimensions
		);

		this.embeddingsDirty = false;
	}

	/**
	 * Get embedding for a node.
	 */
	getEmbedding(nodeId: string): Float32Array | undefined {
		return this.embeddings.get(nodeId);
	}

	/**
	 * Set embedding for a node.
	 */
	setEmbedding(nodeId: string, embedding: Float32Array): void {
		this.embeddings.set(nodeId, embedding);
		this.embeddingsDirty = true;
	}

	/**
	 * Remove embedding for a node.
	 */
	removeEmbedding(nodeId: string): void {
		if (this.embeddings.delete(nodeId)) {
			this.embeddingsDirty = true;
		}
	}

	/**
	 * Check if a node has an embedding.
	 */
	hasEmbedding(nodeId: string): boolean {
		return this.embeddings.has(nodeId);
	}

	/**
	 * Get all nodes that have embeddings.
	 */
	getNodesWithEmbeddings(): string[] {
		return Array.from(this.embeddings.keys());
	}

	/**
	 * Get count of nodes with embeddings.
	 */
	getEmbeddingsCount(): number {
		return this.embeddings.size;
	}

	/**
	 * Find nodes similar to the given embedding.
	 * Returns nodes with similarity above threshold, sorted by similarity.
	 * Optionally filter by entity type.
	 */
	findSimilarByEmbedding(
		query: Float32Array,
		threshold: number,
		entityType?: string
	): Array<{ node: OntologyNode; similarity: number }> {
		const results: Array<{ node: OntologyNode; similarity: number }> = [];

		for (const [nodeId, embedding] of this.embeddings) {
			const node = this.nodeById.get(nodeId);
			if (!node) continue;
			if (entityType && (node.entityType || node.label) !== entityType) continue;

			const sim = cosineSimilarity(query, embedding);
			if (sim >= threshold) {
				results.push({ node, similarity: sim });
			}
		}

		// Sort by similarity descending
		return results.sort((a, b) => b.similarity - a.similarity);
	}

	/**
	 * Find candidates for entity resolution in a similarity range.
	 * Used for finding ambiguous matches that need LLM verification.
	 */
	findCandidatesInRange(
		query: Float32Array,
		minThreshold: number,
		maxThreshold: number,
		entityType?: string
	): Array<{ node: OntologyNode; similarity: number }> {
		const results: Array<{ node: OntologyNode; similarity: number }> = [];

		for (const [nodeId, embedding] of this.embeddings) {
			const node = this.nodeById.get(nodeId);
			if (!node) continue;
			if (entityType && (node.entityType || node.label) !== entityType) continue;

			const sim = cosineSimilarity(query, embedding);
			if (sim >= minThreshold && sim < maxThreshold) {
				results.push({ node, similarity: sim });
			}
		}

		// Sort by similarity descending
		return results.sort((a, b) => b.similarity - a.similarity);
	}

	// --- Persistence ---

	private markDirty(): void {
		this.dirty = true;
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimeout) {
			activeWindow.clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = activeWindow.setTimeout(() => {
			void this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/**
	 * Immediately persist changes to disk.
	 */
	async flush(): Promise<void> {
		if (this.saveTimeout) {
			activeWindow.clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}

		// Save embeddings binary first (updates embeddingIndex)
		if (this.embeddingsDirty) {
			await this.saveEmbeddings();
		}

		const needsSave = this.dirty || this.resolutionCacheDirty || this.embeddingIndex;
		if (!needsSave) return;

		const data: PluginData = (await this.plugin.loadData()) ?? {
			settings: DEFAULT_SETTINGS,
			graph: { nodes: [], edges: [], version: GRAPH_SCHEMA_VERSION },
			hashes: { hashes: [] },
		};

		if (this.dirty) {
			data.graph = {
				nodes: this.nodes,
				edges: this.edges,
				version: this.version,
			};
		}

		if (this.resolutionCacheDirty) {
			// Convert Map to object for JSON storage
			const cacheObj: ResolutionCache = {};
			for (const [token, nodeId] of this.resolutionCache) {
				cacheObj[token] = nodeId;
			}
			data.resolutionCache = cacheObj;
		}

		// Include embedding index if present
		if (this.embeddingIndex) {
			data.embeddingIndex = this.embeddingIndex;
		}

		await this.plugin.saveData(data);
		this.dirty = false;
		this.resolutionCacheDirty = false;
	}

	/**
	 * Clear all graph data.
	 */
	clear(): void {
		this.nodes = [];
		this.edges = [];
		this.resolutionCache.clear();
		this.embeddings.clear();
		this.embeddingIndex = null;
		this.rebuildIndexes();
		this.dirty = true;
		this.resolutionCacheDirty = true;
		this.embeddingsDirty = true;
		this.scheduleSave();
	}

	/**
	 * Get statistics about the graph.
	 * Returns dynamic entity type-based counts.
	 */
	getStats(): { nodes: number; edges: number; labels: Record<string, number>; entityTypes: Record<string, number> } {
		const entityTypes: Record<string, number> = {};
		for (const [entityType, nodes] of this.nodesByEntityType) {
			entityTypes[entityType] = nodes.length;
		}

		// Legacy labels support
		const labels: Record<string, number> = {};
		for (const [label, nodes] of this.nodesByLabel) {
			labels[label] = nodes.length;
		}

		return {
			nodes: this.nodes.length,
			edges: this.edges.length,
			labels,
			entityTypes,
		};
	}

	/**
	 * Get a summary string for status bar.
	 */
	getStatsSummary(): string {
		const stats = this.getStats();
		// Prefer entity types over legacy labels
		const counts = Object.keys(stats.entityTypes).length > 0 ? stats.entityTypes : stats.labels;
		const typeCounts = Object.entries(counts)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([type, count]) => `${count} ${type}`)
			.join(', ');

		return `${stats.nodes} nodes, ${stats.edges} edges${typeCounts ? ` (${typeCounts})` : ''}`;
	}
}
