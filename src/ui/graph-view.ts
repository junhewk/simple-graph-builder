import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds
const LARGE_GRAPH_THRESHOLD = 500; // nodes + edges
const MAX_RENDER_ELEMENTS = 2000; // maximum elements to render

// Obsidian-like color scheme (works in both light and dark themes)
const GRAPH_STYLES: cytoscape.StylesheetStyle[] = [
	// Base node style (Obsidian-like: circular, label below)
	{
		selector: 'node',
		style: {
			'label': 'data(label)',
			'text-valign': 'bottom',
			'text-halign': 'center',
			'text-margin-y': 5,
			'font-size': '10px',
			'font-family': 'var(--font-interface)',
			'color': '#a8a8a8',
			'text-wrap': 'ellipsis',
			'text-max-width': '80px',
			'width': 10,
			'height': 10,
			'border-width': 0,
			'background-opacity': 0.9,
		},
	},
	// Note nodes - purple (like Obsidian's note nodes)
	{
		selector: 'node[type="note"]',
		style: {
			'background-color': '#7f6df2',
			'width': 14,
			'height': 14,
		},
	},
	// Entity nodes - teal/cyan
	{
		selector: 'node[type="entity"]',
		style: {
			'background-color': '#53dfdd',
			'width': 10,
			'height': 10,
		},
	},
	// Keyword nodes - orange/amber
	{
		selector: 'node[type="keyword"]',
		style: {
			'background-color': '#e5a84b',
			'width': 12,
			'height': 12,
		},
	},
	// Base edge style - subtle, thin lines
	{
		selector: 'edge',
		style: {
			'width': 0.5,
			'line-color': '#4a4a4a',
			'curve-style': 'bezier',
			'opacity': 0.6,
		},
	},
	// Mentions edges (note -> entity)
	{
		selector: 'edge[type="mentions"]',
		style: {
			'line-color': '#6a6a8a',
		},
	},
	// Keyword match edges
	{
		selector: 'edge[type="matches_keyword"]',
		style: {
			'line-color': '#8a7a5a',
		},
	},
	// Relates_to edges (entity -> entity)
	{
		selector: 'edge[type="relates_to"]',
		style: {
			'line-color': '#5a8a8a',
			'line-style': 'dashed',
		},
	},
	// Links_to edges (note -> note, internal [[wikilinks]])
	{
		selector: 'edge[type="links_to"]',
		style: {
			'line-color': '#7f6df2',
			'width': 1,
			'target-arrow-shape': 'triangle',
			'target-arrow-color': '#7f6df2',
			'arrow-scale': 0.6,
		},
	},
	// Highlighted state (selected node and neighbors)
	{
		selector: '.highlighted',
		style: {
			'background-color': '#ffffff',
			'color': '#ffffff',
			'opacity': 1,
		},
	},
	{
		selector: 'node.highlighted[type="note"]',
		style: {
			'background-color': '#a89df2',
		},
	},
	{
		selector: 'node.highlighted[type="entity"]',
		style: {
			'background-color': '#7fffff',
		},
	},
	{
		selector: 'node.highlighted[type="keyword"]',
		style: {
			'background-color': '#ffc85b',
		},
	},
	{
		selector: 'edge.highlighted',
		style: {
			'line-color': '#888888',
			'width': 1,
			'opacity': 1,
		},
	},
	// Faded state (non-selected elements)
	{
		selector: '.faded',
		style: {
			'opacity': 0.15,
		},
	},
	// Hover state - brighter label color for visibility
	{
		selector: 'node.hover',
		style: {
			'color': '#ffffff',
			'text-background-color': '#000000',
			'text-background-opacity': 0.7,
			'text-background-padding': '2px',
			'font-weight': 'bold',
			'z-index': 999,
		},
	},
	{
		selector: 'node.hover[type="note"]',
		style: {
			'color': '#c4b5fd',
		},
	},
	{
		selector: 'node.hover[type="entity"]',
		style: {
			'color': '#5eead4',
		},
	},
	{
		selector: 'node.hover[type="keyword"]',
		style: {
			'color': '#fcd34d',
		},
	},
];

export class GraphView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	cy: cytoscape.Core | null = null;
	private graphContainer: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Knowledge Graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('simple-graph-container');

		this.graphContainer = container.createDiv({ cls: 'cytoscape-container' });

		await this.renderGraph();
	}

	/**
	 * Refresh the graph view with latest data.
	 * Called when view is opened or manually refreshed.
	 */
	async refresh(): Promise<void> {
		if (this.graphContainer) {
			await this.renderGraph();
		}
	}

	async renderGraph(): Promise<void> {
		if (!this.graphContainer) return;

		// Destroy existing graph if any
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}

		this.graphContainer.empty();

		const graph = this.plugin.graphCache.getGraphData();

		// Show empty state if no data
		if (graph.nodes.length === 0) {
			this.graphContainer.createEl('div', {
				cls: 'graph-empty-state',
				text: 'No graph data yet. Analyze some notes to build your knowledge graph.',
			});
			return;
		}

		const totalElements = graph.nodes.length + graph.edges.length;
		const isLargeGraph = totalElements > LARGE_GRAPH_THRESHOLD;

		// Show loading indicator for large graphs
		if (isLargeGraph) {
			const loadingEl = this.graphContainer.createEl('div', {
				cls: 'graph-loading',
				text: `Loading graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)...`,
			});

			// Allow UI to update before heavy computation
			await new Promise(resolve => setTimeout(resolve, 50));
			loadingEl.remove();
		}

		// For very large graphs, limit what we render
		let nodesToRender = graph.nodes;
		let edgesToRender = graph.edges;

		if (totalElements > MAX_RENDER_ELEMENTS) {
			// Prioritize note nodes and their direct connections
			const noteNodes = graph.nodes.filter(n => n.type === 'note');
			const noteIds = new Set(noteNodes.map(n => n.id));

			// Get edges connected to notes
			const noteEdges = graph.edges.filter(e => noteIds.has(e.source) || noteIds.has(e.target));

			// Get entity/keyword nodes that are connected to notes
			const connectedIds = new Set<string>();
			for (const edge of noteEdges) {
				connectedIds.add(edge.source);
				connectedIds.add(edge.target);
			}

			const connectedNodes = graph.nodes.filter(n => connectedIds.has(n.id));

			nodesToRender = connectedNodes;
			edgesToRender = noteEdges;

			new Notice(`Large graph: showing ${nodesToRender.length} nodes (notes + connected entities)`);
		}

		const elements: cytoscape.ElementDefinition[] = [];

		// Add nodes
		for (const node of nodesToRender) {
			elements.push({
				data: {
					id: node.id,
					label: node.label,
					type: node.type,
					notePath: node.notePath,
				},
			});
		}

		// Add edges (only if both endpoints exist)
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						type: edge.type,
					},
				});
			}
		}

		// Choose layout based on graph size
		const layoutConfig = this.getLayoutConfig(elements.length, isLargeGraph);

		this.cy = cytoscape({
			container: this.graphContainer,
			elements: elements,
			style: GRAPH_STYLES,
			layout: layoutConfig,
			minZoom: 0.1,
			maxZoom: 3,
			wheelSensitivity: 0.3,
			// Performance optimizations
			textureOnViewport: isLargeGraph,
			hideEdgesOnViewport: isLargeGraph,
			hideLabelsOnViewport: isLargeGraph,
		});

		// Click handler: highlight connected nodes
		this.cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target;
			this.highlightConnected(node);
		});

		// Double-click to open note
		this.cy.on('dbltap', 'node[type="note"]', (evt: cytoscape.EventObject) => {
			const notePath = evt.target.data('notePath');
			if (notePath) {
				this.app.workspace.openLinkText(notePath, '', false);
			}
		});

		// Double-click on entity/keyword to search for related notes
		this.cy.on('dbltap', 'node[type="entity"], node[type="keyword"]', (evt: cytoscape.EventObject) => {
			const label = evt.target.data('label');
			if (label) {
				openSearchModal(this.plugin, label);
			}
		});

		// Click on background to reset highlights
		this.cy.on('tap', (evt: cytoscape.EventObject) => {
			if (evt.target === this.cy) {
				this.resetHighlights();
			}
		});

		// Hover effects - add class for label visibility (works for all graph sizes)
		this.cy.on('mouseover', 'node', (evt: cytoscape.EventObject) => {
			evt.target.addClass('hover');
			// Only scale node size for small graphs (performance)
			if (!isLargeGraph) {
				evt.target.style('width', evt.target.style('width') * 1.3);
				evt.target.style('height', evt.target.style('height') * 1.3);
			}
		});

		this.cy.on('mouseout', 'node', (evt: cytoscape.EventObject) => {
			evt.target.removeClass('hover');
			// Only scale node size for small graphs (performance)
			if (!isLargeGraph) {
				evt.target.style('width', evt.target.style('width') / 1.3);
				evt.target.style('height', evt.target.style('height') / 1.3);
			}
		});
	}

	/**
	 * Get layout configuration based on graph size.
	 * Uses fCoSE (fast Compound Spring Embedder) for all sizes -
	 * it's optimized for large graphs while maintaining good aesthetics.
	 */
	private getLayoutConfig(elementCount: number, isLarge: boolean): cytoscape.LayoutOptions {
		// fCoSE is fast for all graph sizes due to spectral layout initialization
		// Adjust parameters based on graph size for optimal performance
		if (isLarge || elementCount > 1000) {
			// Large graph: prioritize speed, high repulsion for spacing
			return {
				name: 'fcose',
				animate: false,
				quality: 'default',
				randomize: true,
				nodeDimensionsIncludeLabels: false,
				nodeRepulsion: () => 20000, // Increased from 4500
				idealEdgeLength: () => 120,   // Increased from 50
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.1,  // Reduced gravity to allow more spreading
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 30,
				tilingPaddingHorizontal: 30,
				gravityRangeCompound: 1.5,
				gravityCompound: 1.0,
				gravityRange: 3.8,
				initialEnergyOnIncremental: 0.3,
			} as cytoscape.LayoutOptions;
		} else if (elementCount > 300) {
			// Medium graph: balanced settings with good spacing
			return {
				name: 'fcose',
				animate: false,
				quality: 'default',
				randomize: true,
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 25000, // Increased from 6000
				idealEdgeLength: () => 150,  // Increased from 70
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.15, // Reduced gravity
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 40,
				tilingPaddingHorizontal: 40,
			} as cytoscape.LayoutOptions;
		} else {
			// Small graph: best quality with comfortable spacing
			return {
				name: 'fcose',
				animate: false,
				quality: 'proof',
				randomize: true,
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 30000, // Increased from 8000
				idealEdgeLength: () => 200,  // Increased from 100
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.1,  // Reduced gravity
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 50,
				tilingPaddingHorizontal: 50,
			} as cytoscape.LayoutOptions;
		}
	}

	private highlightConnected(node: cytoscape.NodeSingular): void {
		if (!this.cy) return;

		// Reset previous highlights
		this.cy.elements().removeClass('highlighted faded');

		// Get connected nodes and edges
		const neighborhood = node.neighborhood().add(node);
		const others = this.cy.elements().difference(neighborhood);

		// Apply styles
		neighborhood.addClass('highlighted');
		others.addClass('faded');
	}

	private resetHighlights(): void {
		if (!this.cy) return;
		this.cy.elements().removeClass('highlighted faded');
	}

	async onClose() {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}
}
