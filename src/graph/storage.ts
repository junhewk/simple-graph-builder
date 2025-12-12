import { GraphData, GraphNode, GraphEdge, PluginData } from '../types';
import SimpleGraphBuilderPlugin from '../main';

const CURRENT_GRAPH_VERSION = 1;

function createEmptyGraph(): GraphData {
	return {
		nodes: [],
		edges: [],
		version: CURRENT_GRAPH_VERSION,
	};
}

export async function loadGraph(plugin: SimpleGraphBuilderPlugin): Promise<GraphData> {
	const data: PluginData | null = await plugin.loadData();
	if (!data?.graph) {
		return createEmptyGraph();
	}

	// Handle version migration if needed
	const graph = data.graph;
	if (!graph.version) {
		graph.version = CURRENT_GRAPH_VERSION;
	}

	return graph;
}

export async function saveGraph(plugin: SimpleGraphBuilderPlugin, graph: GraphData): Promise<void> {
	const data: PluginData = (await plugin.loadData()) ?? {
		settings: plugin.settings,
		graph: createEmptyGraph(),
		hashes: { hashes: [] },
	};

	graph.version = CURRENT_GRAPH_VERSION;
	data.graph = graph;
	await plugin.saveData(data);
}

// Utility functions for graph operations

export function findNodeById(graph: GraphData, id: string): GraphNode | undefined {
	return graph.nodes.find(n => n.id === id);
}

export function findNodesByType(graph: GraphData, type: GraphNode['type']): GraphNode[] {
	return graph.nodes.filter(n => n.type === type);
}

export function findEdgesBySource(graph: GraphData, sourceId: string): GraphEdge[] {
	return graph.edges.filter(e => e.source === sourceId);
}

export function findEdgesByTarget(graph: GraphData, targetId: string): GraphEdge[] {
	return graph.edges.filter(e => e.target === targetId);
}

export function getConnectedNodes(graph: GraphData, nodeId: string): GraphNode[] {
	const connectedIds = new Set<string>();

	for (const edge of graph.edges) {
		if (edge.source === nodeId) {
			connectedIds.add(edge.target);
		} else if (edge.target === nodeId) {
			connectedIds.add(edge.source);
		}
	}

	return graph.nodes.filter(n => connectedIds.has(n.id));
}

export function removeNoteFromGraph(graph: GraphData, notePath: string): GraphData {
	const noteNode = graph.nodes.find(n => n.type === 'note' && n.notePath === notePath);
	if (!noteNode) {
		return graph;
	}

	// Remove all edges connected to this note
	const newEdges = graph.edges.filter(e => e.source !== noteNode.id && e.target !== noteNode.id);

	// Remove the note node
	const newNodes = graph.nodes.filter(n => n.id !== noteNode.id);

	// Remove orphaned entity nodes (entities with no remaining connections)
	const connectedEntityIds = new Set<string>();
	for (const edge of newEdges) {
		connectedEntityIds.add(edge.source);
		connectedEntityIds.add(edge.target);
	}

	const finalNodes = newNodes.filter(n => {
		if (n.type === 'entity') {
			return connectedEntityIds.has(n.id);
		}
		return true; // keep notes and keywords
	});

	return {
		nodes: finalNodes,
		edges: newEdges,
		version: graph.version,
	};
}

export function clearGraph(): GraphData {
	return createEmptyGraph();
}
