import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { getEntityTypeColor } from '../types';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds
const LARGE_GRAPH_THRESHOLD = 500; // nodes + edges
const MAX_RENDER_ELEMENTS = 2000; // maximum elements to render

// ============================================
// Graph Styles
// ============================================

const GRAPH_STYLES: cytoscape.StylesheetStyle[] = [
	// Base node style
	{
		selector: 'node',
		style: {
			'label': 'data(name)',
			'text-valign': 'bottom',
			'text-halign': 'center',
			'text-margin-y': 5,
			'font-size': '10px',
			'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
			'color': '#a8a8a8',
			'text-wrap': 'ellipsis',
			'text-max-width': '80px',
			'width': 12,
			'height': 12,
			'border-width': 0,
			'background-opacity': 0.9,
			'background-color': 'data(color)',
		},
	},
	// Base edge style (unified for free-form relationships)
	{
		selector: 'edge',
		style: {
			'width': 1,
			'line-color': '#cbd5e1',
			'curve-style': 'bezier',
			'opacity': 0.4,
			'line-style': 'solid',
			'target-arrow-shape': 'triangle',
			'target-arrow-color': '#cbd5e1',
			'arrow-scale': 0.5,
		},
	},
	// Highlighted state (selected node and neighbors)
	{
		selector: '.highlighted',
		style: {
			'opacity': 1,
		},
	},
	{
		selector: 'node.highlighted',
		style: {
			'border-width': 2,
			'border-color': '#ffffff',
			'width': 16,
			'height': 16,
		},
	},
	{
		selector: 'edge.highlighted',
		style: {
			'width': 2,
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
	// Hover state
	{
		selector: 'node.hover',
		style: {
			'width': 16,
			'height': 16,
			'z-index': 999,
		},
	},
];

// ============================================
// Graph View
// ============================================

export class GraphView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	cy: cytoscape.Core | null = null;
	private graphContainer: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Knowledge graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('simple-graph-container');
		container.addClass('sgb-graph-container-relative');

		// Create graph container first (full height)
		this.graphContainer = container.createDiv({ cls: 'cytoscape-container' });

		// Create tooltip element (positioned absolutely, won't affect layout)
		// Styles defined in styles.css via .graph-tooltip class
		this.tooltipEl = container.createDiv({ cls: 'graph-tooltip' });

		await this.renderGraph();
	}

	/**
	 * Refresh the graph view with latest data.
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
			this.graphContainer.createDiv({
				cls: 'graph-empty-state',
				text: 'No graph data yet. Analyze some notes to build your knowledge graph.',
			});
			return;
		}

		const totalElements = graph.nodes.length + graph.edges.length;
		const isLargeGraph = totalElements > LARGE_GRAPH_THRESHOLD;

		// Show loading indicator for large graphs
		if (isLargeGraph) {
			const loadingEl = this.graphContainer.createDiv({
				cls: 'graph-loading',
				text: `Loading graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)...`,
			});

			// Allow UI to update before heavy computation
			await new Promise(resolve => window.setTimeout(resolve, 50));
			loadingEl.remove();
		}

		// Calculate connection count for all nodes (needed for filtering and large graph handling)
		const connectionCount = new Map<string, number>();
		for (const edge of graph.edges) {
			connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
			connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
		}

		// For very large graphs, limit what we render
		let nodesToRender = graph.nodes;
		let edgesToRender = graph.edges;

		if (totalElements > MAX_RENDER_ELEMENTS) {
			// Sort by connection count and take top nodes
			nodesToRender = [...graph.nodes]
				.sort((a, b) => (connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0))
				.slice(0, MAX_RENDER_ELEMENTS / 2);

			const nodeIds = new Set(nodesToRender.map(n => n.id));
			edgesToRender = graph.edges.filter(
				e => nodeIds.has(e.source) && nodeIds.has(e.target)
			);

			new Notice(`Large graph: showing ${nodesToRender.length} most connected nodes`);
		}

		// Apply minimum degree filter from settings
		const minDegree = this.plugin.settings.graphMinDegree;
		if (minDegree > 0) {
			nodesToRender = nodesToRender.filter(node =>
				(connectionCount.get(node.id) || 0) >= minDegree
			);
			const filteredNodeIds = new Set(nodesToRender.map(n => n.id));
			edgesToRender = edgesToRender.filter(
				e => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)
			);
		}

		const elements: cytoscape.ElementDefinition[] = [];

		// Add nodes with entity type colors
		for (const node of nodesToRender) {
			elements.push({
				data: {
					id: node.id,
					name: node.properties.name,
					entityType: node.entityType,
					label: node.label || node.entityType, // fallback for legacy
					color: getEntityTypeColor(node.entityType || node.label),
					sourceNotes: node.sourceNotes,
				},
			});
		}

		// Add edges with unified styling (free-form relationships)
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						relationship: edge.relationship || edge.type || 'relates to',
						detail: edge.properties?.detail,
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

		// Double-click on node to search
		this.cy.on('dbltap', 'node', (evt: cytoscape.EventObject) => {
			const name = evt.target.data('name');
			if (name) {
				openSearchModal(this.plugin, name);
			}
		});

		// Click on background to reset highlights
		this.cy.on('tap', (evt: cytoscape.EventObject) => {
			if (evt.target === this.cy) {
				this.resetHighlights();
				this.hideTooltip();
			}
		});

		// Hover effects for nodes
		this.cy.on('mouseover', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target;
			node.addClass('hover');
			this.showNodeTooltip(node, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'node', (evt: cytoscape.EventObject) => {
			evt.target.removeClass('hover');
			this.hideTooltip();
		});

		// Hover effects for edges - show relationship type and detail
		this.cy.on('mouseover', 'edge', (evt: cytoscape.EventObject) => {
			const edge = evt.target;
			this.showEdgeTooltip(edge, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'edge', () => {
			this.hideTooltip();
		});
	}

	private showNodeTooltip(node: cytoscape.NodeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const name = node.data('name');
		const entityType = node.data('entityType') || node.data('label');
		const sourceNotes = node.data('sourceNotes') || [];

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-label', text: entityType });
		this.tooltipEl.createDiv({ cls: 'tooltip-name', text: name });
		if (sourceNotes.length > 0) {
			this.tooltipEl.createDiv({ cls: 'tooltip-sources', text: `Found in ${sourceNotes.length} note${sourceNotes.length > 1 ? 's' : ''}` });
		}

		this.tooltipEl.style.left = `${position.x + 15}px`;
		this.tooltipEl.style.top = `${position.y + 15}px`;
		this.tooltipEl.addClass('visible');
	}

	private showEdgeTooltip(edge: cytoscape.EdgeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const relationship = edge.data('relationship');
		const detail = edge.data('detail');

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-type', text: relationship });
		if (detail) {
			this.tooltipEl.createDiv({ cls: 'tooltip-detail', text: detail });
		}

		this.tooltipEl.style.left = `${position.x + 15}px`;
		this.tooltipEl.style.top = `${position.y + 15}px`;
		this.tooltipEl.addClass('visible');
	}

	private hideTooltip(): void {
		if (this.tooltipEl) {
			this.tooltipEl.removeClass('visible');
		}
	}

	/**
	 * Get layout configuration based on graph size.
	 */
	private getLayoutConfig(elementCount: number, isLarge: boolean): cytoscape.LayoutOptions {
		// Base config shared across all sizes
		const baseConfig = {
			name: 'fcose',
			animate: false,
			randomize: true,
			edgeElasticity: () => 0.45,
			nestingFactor: 0.1,
			numIter: 2500,
			tile: true,
		};

		// Large graph (1000+ elements or flagged as large)
		if (isLarge || elementCount > 1000) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: false,
				nodeRepulsion: () => 20000,
				idealEdgeLength: () => 120,
				gravity: 0.1,
				tilingPaddingVertical: 30,
				tilingPaddingHorizontal: 30,
			} as cytoscape.LayoutOptions;
		}

		// Medium graph (300-1000 elements)
		if (elementCount > 300) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 25000,
				idealEdgeLength: () => 150,
				gravity: 0.15,
				tilingPaddingVertical: 40,
				tilingPaddingHorizontal: 40,
			} as cytoscape.LayoutOptions;
		}

		// Small graph (<300 elements)
		return {
			...baseConfig,
			quality: 'proof',
			nodeDimensionsIncludeLabels: true,
			nodeRepulsion: () => 30000,
			idealEdgeLength: () => 200,
			gravity: 0.1,
			tilingPaddingVertical: 50,
			tilingPaddingHorizontal: 50,
		} as cytoscape.LayoutOptions;
	}

	private highlightConnected(node: cytoscape.NodeSingular): void {
		if (!this.cy) return;

		this.cy.elements().removeClass('highlighted faded');

		const neighborhood = node.neighborhood().add(node);
		const others = this.cy.elements().difference(neighborhood);

		neighborhood.addClass('highlighted');
		others.addClass('faded');
	}

	private resetHighlights(): void {
		if (!this.cy) return;
		this.cy.elements().removeClass('highlighted faded');
	}

	async onClose(): Promise<void> {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}
}
