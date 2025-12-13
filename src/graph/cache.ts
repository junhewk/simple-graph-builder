import { GraphData, OntologyNode, OntologyEdge, PluginData, GRAPH_SCHEMA_VERSION, isLegacyGraphData } from '../types';
import { DEFAULT_SETTINGS } from '../settings';
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
	private saveTimeout: ReturnType<typeof setTimeout> | null = null;

	// Raw data
	private nodes: OntologyNode[] = [];
	private edges: OntologyEdge[] = [];
	private version = GRAPH_SCHEMA_VERSION;

	// Indexes for O(1) lookups
	private nodeById: Map<string, OntologyNode> = new Map();
	private nodesByLabel: Map<string, OntologyNode[]> = new Map();
	private nodesBySourceNote: Map<string, OntologyNode[]> = new Map();
	private nodeByName: Map<string, OntologyNode> = new Map(); // lowercase name -> node
	private edgeById: Map<string, OntologyEdge> = new Map();
	private edgesBySource: Map<string, OntologyEdge[]> = new Map();
	private edgesByTarget: Map<string, OntologyEdge[]> = new Map();
	private edgesBySourceNote: Map<string, OntologyEdge[]> = new Map();

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
				console.log('Detected legacy v1 graph data. Clearing for v2 schema.');
				this.nodes = [];
				this.edges = [];
				this.version = GRAPH_SCHEMA_VERSION;
				// Clear hashes to allow re-analysis
				if (data.hashes) {
					data.hashes.hashes = [];
				}
				this.dirty = true;
			} else {
				this.nodes = (graph.nodes || []) as OntologyNode[];
				this.edges = (graph.edges || []) as OntologyEdge[];
				this.version = graph.version || GRAPH_SCHEMA_VERSION;
			}
		} else {
			this.nodes = [];
			this.edges = [];
			this.version = GRAPH_SCHEMA_VERSION;
		}

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
	 * Rebuild all indexes from raw arrays.
	 */
	private rebuildIndexes(): void {
		this.nodeById.clear();
		this.nodesByLabel.clear();
		this.nodesBySourceNote.clear();
		this.nodeByName.clear();
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
	 * Add a node to all indexes.
	 */
	private indexNode(node: OntologyNode): void {
		this.nodeById.set(node.id, node);

		// Index by label
		if (!this.nodesByLabel.has(node.label)) {
			this.nodesByLabel.set(node.label, []);
		}
		this.nodesByLabel.get(node.label)!.push(node);

		// Index by source notes
		for (const notePath of node.sourceNotes) {
			if (!this.nodesBySourceNote.has(notePath)) {
				this.nodesBySourceNote.set(notePath, []);
			}
			this.nodesBySourceNote.get(notePath)!.push(node);
		}

		// Index by name (lowercase for case-insensitive lookup)
		this.nodeByName.set(node.properties.name.toLowerCase(), node);
	}

	/**
	 * Remove a node from all indexes.
	 */
	private unindexNode(node: OntologyNode): void {
		this.nodeById.delete(node.id);
		this.nodeByName.delete(node.properties.name.toLowerCase());

		// Remove from label index
		const labelArr = this.nodesByLabel.get(node.label);
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
	 * Add an edge to all indexes.
	 */
	private indexEdge(edge: OntologyEdge): void {
		this.edgeById.set(edge.id, edge);

		if (!this.edgesBySource.has(edge.source)) {
			this.edgesBySource.set(edge.source, []);
		}
		this.edgesBySource.get(edge.source)!.push(edge);

		if (!this.edgesByTarget.has(edge.target)) {
			this.edgesByTarget.set(edge.target, []);
		}
		this.edgesByTarget.get(edge.target)!.push(edge);

		if (edge.sourceNote) {
			if (!this.edgesBySourceNote.has(edge.sourceNote)) {
				this.edgesBySourceNote.set(edge.sourceNote, []);
			}
			this.edgesBySourceNote.get(edge.sourceNote)!.push(edge);
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

	getNodesByLabel(label: string): OntologyNode[] {
		return this.nodesByLabel.get(label) || [];
	}

	getNodesBySourceNote(notePath: string): OntologyNode[] {
		return this.nodesBySourceNote.get(notePath) || [];
	}

	getNodeByName(name: string): OntologyNode | undefined {
		return this.nodeByName.get(name.toLowerCase());
	}

	getAllNodes(): OntologyNode[] {
		return [...this.nodes];
	}

	/**
	 * Get all unique labels in the graph.
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
		const edges: OntologyEdge[] = [];
		edges.push(...(this.edgesBySource.get(nodeId) || []));
		edges.push(...(this.edgesByTarget.get(nodeId) || []));
		return edges;
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

	// --- Persistence ---

	private markDirty(): void {
		this.dirty = true;
		this.scheduleSave();
	}

	private scheduleSave(): void {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
		}
		this.saveTimeout = setTimeout(() => {
			this.flush();
		}, SAVE_DEBOUNCE_MS);
	}

	/**
	 * Immediately persist changes to disk.
	 */
	async flush(): Promise<void> {
		if (this.saveTimeout) {
			clearTimeout(this.saveTimeout);
			this.saveTimeout = null;
		}

		if (!this.dirty) return;

		const data: PluginData = (await this.plugin.loadData()) ?? {
			settings: DEFAULT_SETTINGS,
			graph: { nodes: [], edges: [], version: GRAPH_SCHEMA_VERSION },
			hashes: { hashes: [] },
		};

		data.graph = {
			nodes: this.nodes,
			edges: this.edges,
			version: this.version,
		};

		await this.plugin.saveData(data);
		this.dirty = false;
	}

	/**
	 * Clear all graph data.
	 */
	clear(): void {
		this.nodes = [];
		this.edges = [];
		this.rebuildIndexes();
		this.markDirty();
	}

	/**
	 * Get statistics about the graph.
	 * Returns dynamic label-based counts.
	 */
	getStats(): { nodes: number; edges: number; labels: Record<string, number> } {
		const labels: Record<string, number> = {};
		for (const [label, nodes] of this.nodesByLabel) {
			labels[label] = nodes.length;
		}

		return {
			nodes: this.nodes.length,
			edges: this.edges.length,
			labels,
		};
	}

	/**
	 * Get a summary string for status bar.
	 */
	getStatsSummary(): string {
		const stats = this.getStats();
		const labelCounts = Object.entries(stats.labels)
			.sort((a: [string, number], b: [string, number]) => b[1] - a[1])
			.slice(0, 3)
			.map(([label, count]: [string, number]) => `${count} ${label}`)
			.join(', ');

		return `${stats.nodes} nodes, ${stats.edges} edges${labelCounts ? ` (${labelCounts})` : ''}`;
	}
}
