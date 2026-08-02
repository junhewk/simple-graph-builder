import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { getEntityTypeColor, OntologyEdge } from '../types';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds.
//
// Above LARGE_GRAPH_THRESHOLD the view trades fidelity for frame rate: straight
// edges instead of bezier, no arrowheads, 1x pixel ratio, draft-quality layout.
//
// The render budgets cap nodes AND edges. An earlier version capped only nodes
// and then took the entire induced subgraph, which on a real vault meant 1000
// nodes dragging 107,855 edges into fCoSE — the cap did essentially nothing.
const LARGE_GRAPH_THRESHOLD = 2000; // nodes + edges
const MAX_RENDER_NODES = 5000;
const MAX_RENDER_EDGES = 15000;

// ============================================
// Graph Styles
// ============================================

/**
 * Build the stylesheet. Edge rendering depends on graph size: bezier curves and
 * arrowheads are the two most expensive per-edge primitives, so large graphs
 * drop both.
 */
function buildGraphStyles(isLargeGraph: boolean): cytoscape.StylesheetStyle[] {
	const edgeStyle: cytoscape.Css.Edge = {
		'width': 1,
		'line-color': '#cbd5e1',
		'curve-style': isLargeGraph ? 'straight' : 'bezier',
		'opacity': 0.4,
		'line-style': 'solid',
	};

	if (!isLargeGraph) {
		edgeStyle['target-arrow-shape'] = 'triangle';
		edgeStyle['target-arrow-color'] = '#cbd5e1';
		edgeStyle['arrow-scale'] = 0.5;
	}

	return [
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
				// Stop measuring and drawing labels once they'd be unreadable
				// anyway. This is what keeps the zoomed-out view responsive, and
				// it's how Obsidian's own graph behaves.
				'min-zoomed-font-size': 8,
				'width': 12,
				'height': 12,
				'border-width': 0,
				'background-opacity': 0.9,
				'background-color': 'data(color)',
			},
		},
		// Vault notes: squared off and slightly larger, so the note layer reads as
		// distinct from the entities it connects
		{
			selector: 'node[entityType = "NOTE"]',
			style: {
				'shape': 'round-rectangle',
				'width': 16,
				'height': 16,
			},
		},
		// Base edge style (unified for free-form relationships)
		{
			selector: 'edge',
			style: edgeStyle,
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
}

/**
 * Whether cytoscape's WebGL renderer can be used here.
 *
 * It needs WebGL2, which is normally present in Electron but can be missing
 * under software rendering or a blocked GPU. Falling back to the 2D canvas is
 * slower but correct; failing to start the renderer is not. Probed once.
 */
let webglSupport: boolean | null = null;
function supportsWebgl(): boolean {
	if (webglSupport === null) {
		try {
			webglSupport = !!document.createElement('canvas').getContext('webgl2');
		} catch {
			webglSupport = false;
		}
	}
	return webglSupport;
}

/**
 * Count how many of the given edges touch each node.
 */
function countDegrees(edges: OntologyEdge[]): Map<string, number> {
	const degrees = new Map<string, number>();
	for (const edge of edges) {
		degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
		degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
	}
	return degrees;
}

// ============================================
// Graph View
// ============================================

export class GraphView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	cy: cytoscape.Core | null = null;
	private graphContainer: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;
	/** Guards against overlapping renders; see renderGraph. */
	private renderToken = 0;

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

		const token = ++this.renderToken;

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

		// Show a loading indicator for large graphs. It stays up until the layout
		// settles — removing it before the blocking work, as an earlier version
		// did, just showed the user a frozen blank pane instead.
		let loadingEl: HTMLElement | null = null;
		if (isLargeGraph) {
			loadingEl = this.graphContainer.createDiv({
				cls: 'graph-loading',
				text: `Loading graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)...`,
			});

			// Allow UI to update before heavy computation
			await new Promise(resolve => window.setTimeout(resolve, 50));
		}

		let nodesToRender = graph.nodes;
		let edgesToRender = graph.edges;

		// Hide the note layer if the user prefers an entity-only graph
		if (!this.plugin.settings.graphShowNotes) {
			nodesToRender = nodesToRender.filter(n => n.entityType !== 'NOTE');
			const visible = new Set(nodesToRender.map(n => n.id));
			edgesToRender = edgesToRender.filter(e => visible.has(e.source) && visible.has(e.target));
		}

		// Degree over the currently visible edge set, not the whole graph, so
		// truncation and the min-degree filter rank what's actually on screen
		let connectionCount = countDegrees(edgesToRender);

		// Apply minimum degree filter from settings
		const minDegree = this.plugin.settings.graphMinDegree;
		if (minDegree > 0) {
			nodesToRender = nodesToRender.filter(node =>
				(connectionCount.get(node.id) || 0) >= minDegree
			);
			const visible = new Set(nodesToRender.map(n => n.id));
			edgesToRender = edgesToRender.filter(e => visible.has(e.source) && visible.has(e.target));
			connectionCount = countDegrees(edgesToRender);
		}

		// Budget nodes and edges separately, keeping the best-connected of each
		const truncated: string[] = [];

		if (nodesToRender.length > MAX_RENDER_NODES) {
			truncated.push(`${nodesToRender.length} nodes to ${MAX_RENDER_NODES}`);
			nodesToRender = [...nodesToRender]
				.sort((a, b) => (connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0))
				.slice(0, MAX_RENDER_NODES);
			const visible = new Set(nodesToRender.map(n => n.id));
			edgesToRender = edgesToRender.filter(e => visible.has(e.source) && visible.has(e.target));
		}

		if (edgesToRender.length > MAX_RENDER_EDGES) {
			truncated.push(`${edgesToRender.length} edges to ${MAX_RENDER_EDGES}`);
			// Keep edges between the best-connected endpoints
			edgesToRender = [...edgesToRender]
				.sort((a, b) =>
					((connectionCount.get(b.source) || 0) + (connectionCount.get(b.target) || 0)) -
					((connectionCount.get(a.source) || 0) + (connectionCount.get(a.target) || 0))
				)
				.slice(0, MAX_RENDER_EDGES);
		}

		if (truncated.length > 0) {
			new Notice(`Large graph: trimmed ${truncated.join(' and ')}`);
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

		// WebGL is a plain canvas-renderer flag in cytoscape 3.31+. It falls back
		// to 2D above zoom 7.99, which maxZoom below keeps out of reach, so it
		// stays active at every zoom level the user can get to.
		const dark = document.body.hasClass('theme-dark');
		const rendererOptions = {
			webgl: supportsWebgl(),
			// The WebGL renderer reads this but cytoscape's bundled .d.ts doesn't
			// declare it, hence the cast. It defaults to white, which flashes
			// wrong against a dark Obsidian theme.
			webglBgColor: dark ? [0, 0, 0] : [255, 255, 255],
			// Unset means full device pixel ratio, which is a 2-4x fill-rate cost
			// on a retina display for a graph that is mostly 1px lines
			...(isLargeGraph ? { pixelRatio: 1 } : {}),
		} as Partial<cytoscape.CytoscapeOptions>;

		this.cy = cytoscape({
			container: this.graphContainer,
			elements: elements,
			style: buildGraphStyles(isLargeGraph),
			// Lay out explicitly after construction so the loading indicator can
			// stay up until the graph is actually positioned
			layout: { name: 'preset' },
			minZoom: 0.1,
			maxZoom: 3,
			// Performance optimizations
			...rendererOptions,
			textureOnViewport: isLargeGraph,
			hideEdgesOnViewport: isLargeGraph,
			hideLabelsOnViewport: isLargeGraph,
		});

		try {
			const layout = this.cy.layout(layoutConfig);
			const settled = layout.promiseOn('layoutstop');
			layout.run();
			await settled;
		} finally {
			// Even on a layout error the indicator has to go, or the view is stuck
			// showing "Loading graph..." forever
			loadingEl?.remove();
		}

		// A second render may have started and destroyed this instance while the
		// layout was running -- opening the graph view twice in quick succession
		// is enough. Binding handlers to the old instance would leak them.
		if (token !== this.renderToken) return;

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
				// 'default' runs the spectral placement AND a full CoSE refinement
				// at numIter; 'draft' stops after spectral. On a big graph that
				// refinement is the whole cost of opening the view.
				quality: 'draft',
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

		// Batched: without this, each of the three class operations triggers its
		// own style recalculation and redraw across every element in the graph.
		this.cy.batch(() => {
			if (!this.cy) return;
			this.cy.elements().removeClass('highlighted faded');

			const neighborhood = node.neighborhood().add(node);
			const others = this.cy.elements().difference(neighborhood);

			neighborhood.addClass('highlighted');
			others.addClass('faded');
		});
	}

	private resetHighlights(): void {
		if (!this.cy) return;

		// Scoped to what is actually marked. Every background tap used to sweep
		// the whole graph, even with nothing highlighted.
		const marked = this.cy.elements('.highlighted, .faded');
		if (marked.length === 0) return;
		marked.removeClass('highlighted faded');
	}

	async onClose(): Promise<void> {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}
}
