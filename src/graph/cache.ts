import { GraphData, GraphNode, GraphEdge, PluginData, NodeType } from '../types';
import { DEFAULT_SETTINGS } from '../settings';
import type SimpleGraphBuilderPlugin from '../main';

const CURRENT_GRAPH_VERSION = 1;
const SAVE_DEBOUNCE_MS = 1000;

/**
 * GraphCache provides O(1) lookups via Maps and debounced persistence.
 * Replaces direct storage.ts usage for better performance with large graphs.
 */
export class GraphCache {
	private plugin: SimpleGraphBuilderPlugin;
	private loaded = false;
	private dirty = false;
	private saveTimeout: ReturnType<typeof setTimeout> | null = null;

	// Raw data
	private nodes: GraphNode[] = [];
	private edges: GraphEdge[] = [];
	private version = CURRENT_GRAPH_VERSION;

	// Indexes for O(1) lookups
	private nodeById: Map<string, GraphNode> = new Map();
	private nodesByType: Map<NodeType, GraphNode[]> = new Map();
	private nodeByNotePath: Map<string, GraphNode> = new Map();
	private edgeById: Map<string, GraphEdge> = new Map();
	private edgesBySource: Map<string, GraphEdge[]> = new Map();
	private edgesByTarget: Map<string, GraphEdge[]> = new Map();

	constructor(plugin: SimpleGraphBuilderPlugin) {
		this.plugin = plugin;
	}

	/**
	 * Ensure graph is loaded into memory. Idempotent.
	 */
	async ensureLoaded(): Promise<void> {
		if (this.loaded) return;

		const data: PluginData | null = await this.plugin.loadData();
		const graph = data?.graph;

		if (graph) {
			this.nodes = graph.nodes || [];
			this.edges = graph.edges || [];
			this.version = graph.version || CURRENT_GRAPH_VERSION;
		} else {
			this.nodes = [];
			this.edges = [];
			this.version = CURRENT_GRAPH_VERSION;
		}

		this.rebuildIndexes();
		this.loaded = true;
	}

	/**
	 * Rebuild all indexes from raw arrays.
	 */
	private rebuildIndexes(): void {
		this.nodeById.clear();
		this.nodesByType.clear();
		this.nodeByNotePath.clear();
		this.edgeById.clear();
		this.edgesBySource.clear();
		this.edgesByTarget.clear();

		// Initialize type arrays
		this.nodesByType.set('note', []);
		this.nodesByType.set('entity', []);
		this.nodesByType.set('keyword', []);

		for (const node of this.nodes) {
			this.nodeById.set(node.id, node);
			this.nodesByType.get(node.type)!.push(node);
			if (node.notePath) {
				this.nodeByNotePath.set(node.notePath, node);
			}
		}

		for (const edge of this.edges) {
			this.edgeById.set(edge.id, edge);

			if (!this.edgesBySource.has(edge.source)) {
				this.edgesBySource.set(edge.source, []);
			}
			this.edgesBySource.get(edge.source)!.push(edge);

			if (!this.edgesByTarget.has(edge.target)) {
				this.edgesByTarget.set(edge.target, []);
			}
			this.edgesByTarget.get(edge.target)!.push(edge);
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

	getNodeById(id: string): GraphNode | undefined {
		return this.nodeById.get(id);
	}

	getNodesByType(type: NodeType): GraphNode[] {
		return this.nodesByType.get(type) || [];
	}

	getNodeByNotePath(path: string): GraphNode | undefined {
		return this.nodeByNotePath.get(path);
	}

	getAllNodes(): GraphNode[] {
		return [...this.nodes];
	}

	addNode(node: GraphNode): void {
		if (this.nodeById.has(node.id)) {
			// Update existing
			const existing = this.nodeById.get(node.id)!;
			Object.assign(existing, node);
		} else {
			// Add new
			this.nodes.push(node);
			this.nodeById.set(node.id, node);
			this.nodesByType.get(node.type)!.push(node);
			if (node.notePath) {
				this.nodeByNotePath.set(node.notePath, node);
			}
		}
		this.markDirty();
	}

	removeNode(id: string): boolean {
		const node = this.nodeById.get(id);
		if (!node) return false;

		// Remove from arrays
		const idx = this.nodes.indexOf(node);
		if (idx >= 0) this.nodes.splice(idx, 1);

		const typeArr = this.nodesByType.get(node.type);
		if (typeArr) {
			const typeIdx = typeArr.indexOf(node);
			if (typeIdx >= 0) typeArr.splice(typeIdx, 1);
		}

		// Remove from maps
		this.nodeById.delete(id);
		if (node.notePath) {
			this.nodeByNotePath.delete(node.notePath);
		}

		// Remove connected edges
		this.removeEdgesByNode(id);

		this.markDirty();
		return true;
	}

	// --- Edge operations (O(1) lookups) ---

	getEdgeById(id: string): GraphEdge | undefined {
		return this.edgeById.get(id);
	}

	getEdgesBySource(sourceId: string): GraphEdge[] {
		return this.edgesBySource.get(sourceId) || [];
	}

	getEdgesByTarget(targetId: string): GraphEdge[] {
		return this.edgesByTarget.get(targetId) || [];
	}

	getAllEdges(): GraphEdge[] {
		return [...this.edges];
	}

	addEdge(edge: GraphEdge): void {
		if (this.edgeById.has(edge.id)) return; // Already exists

		this.edges.push(edge);
		this.edgeById.set(edge.id, edge);

		if (!this.edgesBySource.has(edge.source)) {
			this.edgesBySource.set(edge.source, []);
		}
		this.edgesBySource.get(edge.source)!.push(edge);

		if (!this.edgesByTarget.has(edge.target)) {
			this.edgesByTarget.set(edge.target, []);
		}
		this.edgesByTarget.get(edge.target)!.push(edge);

		this.markDirty();
	}

	removeEdge(id: string): boolean {
		const edge = this.edgeById.get(id);
		if (!edge) return false;

		// Remove from arrays
		const idx = this.edges.indexOf(edge);
		if (idx >= 0) this.edges.splice(idx, 1);

		const sourceArr = this.edgesBySource.get(edge.source);
		if (sourceArr) {
			const sIdx = sourceArr.indexOf(edge);
			if (sIdx >= 0) sourceArr.splice(sIdx, 1);
		}

		const targetArr = this.edgesByTarget.get(edge.target);
		if (targetArr) {
			const tIdx = targetArr.indexOf(edge);
			if (tIdx >= 0) targetArr.splice(tIdx, 1);
		}

		this.edgeById.delete(id);
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

	getConnectedNodes(nodeId: string): GraphNode[] {
		const connectedIds = new Set<string>();

		for (const edge of this.getEdgesBySource(nodeId)) {
			connectedIds.add(edge.target);
		}
		for (const edge of this.getEdgesByTarget(nodeId)) {
			connectedIds.add(edge.source);
		}

		const result: GraphNode[] = [];
		for (const id of connectedIds) {
			const node = this.nodeById.get(id);
			if (node) result.push(node);
		}
		return result;
	}

	/**
	 * Get all entity labels (for LLM context).
	 */
	getExistingEntityLabels(): string[] {
		return this.getNodesByType('entity').map(n => n.label);
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
			graph: { nodes: [], edges: [], version: CURRENT_GRAPH_VERSION },
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
	 * Remove a note and its orphaned entities.
	 */
	removeNoteByPath(notePath: string): boolean {
		const noteNode = this.nodeByNotePath.get(notePath);
		if (!noteNode) return false;

		// Collect entity IDs connected to this note before removal
		const connectedEntityIds = new Set<string>();
		for (const edge of this.getEdgesBySource(noteNode.id)) {
			const target = this.nodeById.get(edge.target);
			if (target?.type === 'entity') {
				connectedEntityIds.add(target.id);
			}
		}

		// Remove the note node (also removes its edges)
		this.removeNode(noteNode.id);

		// Check each connected entity - remove if orphaned
		for (const entityId of connectedEntityIds) {
			const entity = this.nodeById.get(entityId);
			if (!entity) continue;

			// Check if entity has any remaining connections
			const hasConnections =
				this.getEdgesBySource(entityId).length > 0 ||
				this.getEdgesByTarget(entityId).length > 0;

			if (!hasConnections) {
				this.removeNode(entityId);
			}
		}

		return true;
	}

	/**
	 * Get statistics about the graph.
	 */
	getStats(): { nodes: number; edges: number; notes: number; entities: number; keywords: number } {
		return {
			nodes: this.nodes.length,
			edges: this.edges.length,
			notes: this.getNodesByType('note').length,
			entities: this.getNodesByType('entity').length,
			keywords: this.getNodesByType('keyword').length,
		};
	}
}
