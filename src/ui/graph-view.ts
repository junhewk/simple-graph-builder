import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { OntologyNode, OntologyEdge, RelationshipType } from '../types';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds
const LARGE_GRAPH_THRESHOLD = 500; // nodes + edges
const MAX_RENDER_ELEMENTS = 2000; // maximum elements to render

// ============================================
// Dynamic Label Colors
// ============================================

// Base colors for common labels (fallback to hash-based color for others)
const LABEL_COLORS: Record<string, string> = {
	// People & Organizations
	Person: '#6366f1',       // indigo
	Organization: '#8b5cf6', // violet
	Team: '#a78bfa',         // light violet

	// Concepts & Ideas
	Concept: '#14b8a6',      // teal
	Theory: '#2dd4bf',       // light teal
	Method: '#5eead4',       // cyan
	Technique: '#67e8f9',    // light cyan

	// Projects & Products
	Project: '#a855f7',      // purple
	Product: '#c084fc',      // light purple
	System: '#d8b4fe',       // lavender
	Application: '#e9d5ff',  // pale lavender

	// Tools & Software
	Tool: '#f59e0b',         // amber
	Library: '#fbbf24',      // yellow
	Framework: '#fcd34d',    // light yellow
	Software: '#fde68a',     // pale yellow

	// Events
	Event: '#f472b6',        // pink
	Meeting: '#f9a8d4',      // light pink
	Conference: '#fbcfe8',   // pale pink

	// Documents
	Document: '#60a5fa',     // blue
	Paper: '#93c5fd',        // light blue
	Book: '#bfdbfe',         // pale blue
	Article: '#dbeafe',      // very pale blue

	// Places
	Place: '#4ade80',        // green
	Location: '#86efac',     // light green
};

// Generate color from string hash for unlisted labels
function getLabelColor(label: string): string {
	if (LABEL_COLORS[label]) return LABEL_COLORS[label];

	// Hash-based color generation
	let hash = 0;
	for (let i = 0; i < label.length; i++) {
		hash = label.charCodeAt(i) + ((hash << 5) - hash);
	}
	const hue = Math.abs(hash) % 360;
	return `hsl(${hue}, 70%, 60%)`;
}

// Edge styles by relationship type (fixed 5 types)
const RELATIONSHIP_STYLES: Record<RelationshipType, { lineStyle: string; color: string; width?: number; arrow?: boolean; opacity?: number }> = {
	HAS_PART: { lineStyle: 'solid', color: '#64748b', width: 1.5 },      // gray - structural
	LEADS_TO: { lineStyle: 'solid', color: '#3b82f6', width: 1.2, arrow: true }, // blue - causal
	ACTED_ON: { lineStyle: 'solid', color: '#22c55e', width: 1.2 },      // green - action
	CITES: { lineStyle: 'dashed', color: '#8b5cf6', width: 1 },          // purple - reference
	RELATED_TO: { lineStyle: 'dotted', color: '#94a3b8', opacity: 0.7 }, // light gray - loose
};

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
	// Base edge style
	{
		selector: 'edge',
		style: {
			'width': 0.8,
			'line-color': 'data(color)',
			'curve-style': 'bezier',
			'opacity': 0.7,
			'line-style': 'solid',
		},
	},
	// Edges with arrows
	{
		selector: 'edge[arrow="true"]',
		style: {
			'target-arrow-shape': 'triangle',
			'target-arrow-color': 'data(color)',
			'arrow-scale': 0.6,
		},
	},
	// Dashed edges
	{
		selector: 'edge[lineStyle="dashed"]',
		style: {
			'line-style': 'dashed',
		},
	},
	// Dotted edges
	{
		selector: 'edge[lineStyle="dotted"]',
		style: {
			'line-style': 'dotted',
			'opacity': 0.5,
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
		return 'Knowledge Graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('simple-graph-container');
		container.style.position = 'relative';

		// Create graph container first (full height)
		this.graphContainer = container.createDiv({ cls: 'cytoscape-container' });

		// Create tooltip element (positioned absolutely, won't affect layout)
		this.tooltipEl = container.createDiv({ cls: 'graph-tooltip' });
		this.tooltipEl.style.position = 'absolute';
		this.tooltipEl.style.zIndex = '1000';
		this.tooltipEl.style.pointerEvents = 'none';
		this.tooltipEl.style.display = 'none';

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
		let nodesToRender = graph.nodes as OntologyNode[];
		let edgesToRender = graph.edges as OntologyEdge[];

		if (totalElements > MAX_RENDER_ELEMENTS) {
			// Prioritize nodes with more connections
			const connectionCount = new Map<string, number>();
			for (const edge of graph.edges) {
				connectionCount.set(edge.source, (connectionCount.get(edge.source) || 0) + 1);
				connectionCount.set(edge.target, (connectionCount.get(edge.target) || 0) + 1);
			}

			// Sort by connection count and take top nodes
			nodesToRender = [...graph.nodes]
				.sort((a, b) => (connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0))
				.slice(0, MAX_RENDER_ELEMENTS / 2) as OntologyNode[];

			const nodeIds = new Set(nodesToRender.map(n => n.id));
			edgesToRender = (graph.edges as OntologyEdge[]).filter(
				e => nodeIds.has(e.source) && nodeIds.has(e.target)
			);

			new Notice(`Large graph: showing ${nodesToRender.length} most connected nodes`);
		}

		const elements: cytoscape.ElementDefinition[] = [];

		// Add nodes with dynamic colors
		for (const node of nodesToRender) {
			elements.push({
				data: {
					id: node.id,
					name: node.properties.name,
					label: node.label,
					color: getLabelColor(node.label),
					sourceNotes: node.sourceNotes,
				},
			});
		}

		// Add edges with type-based styling
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				const style = RELATIONSHIP_STYLES[edge.type] || RELATIONSHIP_STYLES.RELATED_TO;
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						type: edge.type,
						detail: edge.properties.detail,
						color: style.color,
						lineStyle: style.lineStyle,
						arrow: style.arrow ? 'true' : 'false',
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
		const label = node.data('label');
		const sourceNotes = node.data('sourceNotes') || [];

		let html = `<div class="tooltip-label">${label}</div>`;
		html += `<div class="tooltip-name">${name}</div>`;
		if (sourceNotes.length > 0) {
			html += `<div class="tooltip-sources">Found in ${sourceNotes.length} note${sourceNotes.length > 1 ? 's' : ''}</div>`;
		}

		this.tooltipEl.innerHTML = html;
		this.tooltipEl.style.left = `${position.x + 15}px`;
		this.tooltipEl.style.top = `${position.y + 15}px`;
		this.tooltipEl.style.display = 'block';
	}

	private showEdgeTooltip(edge: cytoscape.EdgeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const type = edge.data('type');
		const detail = edge.data('detail');

		let html = `<div class="tooltip-type">${type}</div>`;
		if (detail) {
			html += `<div class="tooltip-detail">${detail}</div>`;
		}

		this.tooltipEl.innerHTML = html;
		this.tooltipEl.style.left = `${position.x + 15}px`;
		this.tooltipEl.style.top = `${position.y + 15}px`;
		this.tooltipEl.style.display = 'block';
	}

	private hideTooltip(): void {
		if (this.tooltipEl) {
			this.tooltipEl.style.display = 'none';
		}
	}

	/**
	 * Get layout configuration based on graph size.
	 */
	private getLayoutConfig(elementCount: number, isLarge: boolean): cytoscape.LayoutOptions {
		if (isLarge || elementCount > 1000) {
			return {
				name: 'fcose',
				animate: false,
				quality: 'default',
				randomize: true,
				nodeDimensionsIncludeLabels: false,
				nodeRepulsion: () => 20000,
				idealEdgeLength: () => 120,
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.1,
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 30,
				tilingPaddingHorizontal: 30,
			} as cytoscape.LayoutOptions;
		} else if (elementCount > 300) {
			return {
				name: 'fcose',
				animate: false,
				quality: 'default',
				randomize: true,
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 25000,
				idealEdgeLength: () => 150,
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.15,
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 40,
				tilingPaddingHorizontal: 40,
			} as cytoscape.LayoutOptions;
		} else {
			return {
				name: 'fcose',
				animate: false,
				quality: 'proof',
				randomize: true,
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 30000,
				idealEdgeLength: () => 200,
				edgeElasticity: () => 0.45,
				nestingFactor: 0.1,
				gravity: 0.1,
				numIter: 2500,
				tile: true,
				tilingPaddingVertical: 50,
				tilingPaddingHorizontal: 50,
			} as cytoscape.LayoutOptions;
		}
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

	async onClose() {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}
}
