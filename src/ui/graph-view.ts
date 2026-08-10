import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { getEntityTypeColor } from '../types';
import { refineLayout, spacingForNodeCount, LayoutNode, LayoutEdge } from '../graph/layout';
import { computeGraphVisualMetrics, countVisibleDegrees } from '../graph/visual-metrics';

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

// Above this node count fCoSE's force-directed refinement stops being
// affordable -- its cost is roughly quadratic. Measured on a 2:1 edge/node
// graph: 500 nodes 1.8s, 1000 nodes 5.7s, 2500 nodes 38s, 5177 nodes 164s.
// Larger graphs run a two-stage pipeline instead: fCoSE 'draft' (spectral
// placement, sub-second) seeds refineLayout's ForceAtlas2 run, which is
// O(n log n) per iteration under Barnes-Hut -- seconds at 2263 nodes for a
// comparable result.
const DRAFT_LAYOUT_NODE_THRESHOLD = 1000;

// Zoom at which edges stop being drawn at overview weight. Labels appear at
// 0.8 (min-zoomed-font-size 8 over a 10px font), so the mesh has already
// thinned out by the time there is text to read behind it.
const EDGE_OVERVIEW_MAX_ZOOM = 0.5;

// ============================================
// Graph Styles
// ============================================

/**
 * Colours for the two backgrounds Obsidian can put behind the graph.
 *
 * Edges were hardcoded to a light slate (#cbd5e1) picked against a dark
 * background. On a light theme that is very nearly white on white, and a user
 * reported a 5177-node graph looking like an empty pane. These pairs were
 * chosen by rendering a 5000-node graph on both backgrounds and comparing.
 *
 * Deliberately fixed values rather than Obsidian's --text-faint and friends:
 * a theme variable adapts to custom themes, but its actual value is unknown
 * here, and picking an unverified colour is what caused the bug.
 */
function themeColors(): { edge: string; label: string; highlight: string } {
	return document.body.hasClass('theme-dark')
		? { edge: '#cbd5e1', label: '#a8a8a8', highlight: '#ffffff' }
		: { edge: '#64748b', label: '#5c6370', highlight: '#1e1e1e' };
}

/**
 * Build the stylesheet. Edge rendering depends on graph size: bezier curves and
 * arrowheads are the two most expensive per-edge primitives, so large graphs
 * drop both.
 */
function buildGraphStyles(isLargeGraph: boolean): cytoscape.StylesheetStyle[] {
	const { edge: edgeColor, label: labelColor, highlight } = themeColors();
	const nodeSize = (node: cytoscape.NodeSingular): number => nodeData(node).size;
	const emphasizedNodeSize = (node: cytoscape.NodeSingular): number => nodeData(node).emphasizedSize;
	const edgeOpacity = (edge: cytoscape.EdgeSingular): number => edgeData(edge).opacity;
	const overviewEdgeOpacity = (edge: cytoscape.EdgeSingular): number => edgeData(edge).overviewOpacity;

	// This is the weight edges are drawn at once the user has zoomed in far
	// enough to read the graph. A dense graph needs them lighter than a sparse
	// one here, or the mesh buries the nodes and their labels.
	const edgeStyle: cytoscape.Css.Edge = {
		'width': 1,
		'line-color': edgeColor,
		'curve-style': isLargeGraph ? 'straight' : 'bezier',
		'opacity': edgeOpacity,
		'line-style': 'solid',
		// Keep the mesh under the nodes and labels it connects
		'z-index': 0,
	};

	if (!isLargeGraph) {
		edgeStyle['target-arrow-shape'] = 'triangle';
		edgeStyle['target-arrow-color'] = edgeColor;
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
				'color': labelColor,
				'text-wrap': 'ellipsis',
				'text-max-width': '80px',
				// Stop measuring and drawing labels once they'd be unreadable
				// anyway. This is what keeps the zoomed-out view responsive, and
				// it's how Obsidian's own graph behaves.
				'min-zoomed-font-size': 8,
				'width': nodeSize,
				'height': nodeSize,
				'border-width': 0,
				'background-opacity': 0.9,
				'background-color': 'data(color)',
				'z-index': 1,
			},
		},
		// Vault notes keep a distinct shape. Their connectivity now determines
		// their size using the same scale as every other node.
		{
			selector: 'node[entityType = "NOTE"]',
			style: {
				'shape': 'round-rectangle',
			},
		},
		// Base edge style (unified for free-form relationships)
		{
			selector: 'edge',
			style: edgeStyle,
		},
		// Zoomed out, a 1px edge covers a fraction of a pixel and only the
		// aggregate registers, so the mesh is drawn bolder to make the first
		// view read as structure rather than haze. updateEdgeWeight swaps this
		// off as soon as the user zooms in to read.
		{
			selector: 'edge.overview',
			style: {
				'width': 1.4,
				'opacity': overviewEdgeOpacity,
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
				// White reads as a halo on a dark theme and vanishes on a light one
				'border-color': highlight,
				'width': emphasizedNodeSize,
				'height': emphasizedNodeSize,
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
			selector: 'node.faded',
			style: {
				'opacity': 0.15,
			},
		},
		{
			selector: 'edge.faded',
			style: {
				// Must stay below the lightest normal edge; a fixed 0.15 would
				// accidentally brighten low-importance edges on large graphs.
				'opacity': 0.04,
			},
		},
		// Hover state
		{
			selector: 'node.hover',
			style: {
				'width': emphasizedNodeSize,
				'height': emphasizedNodeSize,
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
			webglSupport = !!createEl('canvas').getContext('webgl2');
		} catch {
			webglSupport = false;
		}
	}
	return webglSupport;
}

/**
 * What we attach to each cytoscape element. Cytoscape types `data()` and
 * `evt.target` as `any`, so reading them through these keeps the view code
 * type-checked instead of silently untyped.
 */
interface GraphNodeData {
	id: string;
	name: string;
	entityType?: string;
	label?: string;
	color: string;
	sourceNotes: string[];
	degree: number;
	size: number;
	emphasizedSize: number;
}

interface GraphEdgeData {
	id: string;
	source: string;
	target: string;
	relationship: string;
	detail?: string;
	opacity: number;
	overviewOpacity: number;
}

function nodeData(node: cytoscape.NodeSingular): GraphNodeData {
	return node.data() as GraphNodeData;
}

function edgeData(edge: cytoscape.EdgeSingular): GraphEdgeData {
	return edge.data() as GraphEdgeData;
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
	/** Whether edges currently carry the bold overview weight; see updateEdgeWeight. */
	private edgesBold = false;
	/** Node the current highlight is anchored to, if any; see highlightConnected. */
	private selectedNodeId: string | null = null;

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
		// Focusable so the graph can take key events once clicked, which is what
		// makes Escape a reliable way to release a highlight
		this.graphContainer.tabIndex = 0;
		this.registerDomEvent(this.graphContainer, 'keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Escape' && this.selectedNodeId !== null) {
				this.resetHighlights();
				this.hideTooltip();
				// Only swallow the key when it actually released something, so
				// Escape still closes the pane otherwise
				evt.preventDefault();
			}
		});

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
		let connectionCount = countVisibleDegrees(nodesToRender.map(node => node.id), edgesToRender);

		// Apply minimum degree filter from settings
		const minDegree = this.plugin.settings.graphMinDegree;
		if (minDegree > 0) {
			nodesToRender = nodesToRender.filter(node =>
				(connectionCount.get(node.id) || 0) >= minDegree
			);
			const visible = new Set(nodesToRender.map(n => n.id));
			edgesToRender = edgesToRender.filter(e => visible.has(e.source) && visible.has(e.target));
			connectionCount = countVisibleDegrees(nodesToRender.map(node => node.id), edgesToRender);
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

		// Styling metrics belong to the final visible graph. Recalculate after
		// every filter and budget so hidden edges cannot inflate a node's size.
		const visualMetrics = computeGraphVisualMetrics(
			nodesToRender.map(node => node.id),
			edgesToRender,
			isLargeGraph
		);

		const elements: cytoscape.ElementDefinition[] = [];

		// Add nodes with entity type colors
		for (const node of nodesToRender) {
			const metric = visualMetrics.nodes.get(node.id)!;
			elements.push({
				data: {
					id: node.id,
					name: node.properties.name,
					entityType: node.entityType,
					label: node.label || node.entityType, // fallback for legacy
					color: getEntityTypeColor(node.entityType || node.label),
					sourceNotes: node.sourceNotes,
					degree: metric.degree,
					size: metric.size,
					emphasizedSize: metric.emphasizedSize,
				},
			});
		}

		// Add edges with unified styling (free-form relationships)
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				const metric = visualMetrics.edges.get(edge.id)!;
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						relationship: edge.relationship || edge.type || 'relates to',
						detail: edge.properties?.detail,
						opacity: metric.opacity,
						overviewOpacity: metric.overviewOpacity,
					},
				});
			}
		}

		// Choose layout based on graph size
		const usesDraftLayout = nodesToRender.length > DRAFT_LAYOUT_NODE_THRESHOLD;
		const layoutConfig = this.getLayoutConfig(nodesToRender.length, elements.length);

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
			// A spread-out graph can need to zoom well past 0.1 to fit, especially
			// in the right sidebar, which is only a few hundred pixels wide.
			// Clamping there is what leaves the user staring at one corner of the
			// graph with no way to zoom out. This applies at every size now that
			// the spacing pass scales layouts up to clear labels: an 871-node
			// graph comes out ~6000px tall, which needs zoom ~0.07 in a sidebar.
			minZoom: 0.01,
			maxZoom: 3,
			// Performance optimizations
			...rendererOptions,
			textureOnViewport: isLargeGraph,
			hideEdgesOnViewport: isLargeGraph,
			hideLabelsOnViewport: isLargeGraph,
		});

		// Fresh instance: no edge carries the overview class yet and nothing is
		// selected, whatever the previous render left these set to
		this.edgesBold = false;
		this.selectedNodeId = null;

		try {
			const layout = this.cy.layout(layoutConfig);
			const settled = layout.promiseOn('layoutstop');
			layout.run();
			await settled;

			// Every graph goes through the spacing pass; large ones get the force
			// refinement first. Re-fit afterwards, since the layout's own fit ran
			// against the pre-refinement coordinates.
			if (await this.refineLayoutPositions(token, usesDraftLayout)) {
				this.cy.fit(undefined, 30);
			}
		} finally {
			// Even on a layout error the indicator has to go, or the view is stuck
			// showing "Loading graph..." forever
			loadingEl?.remove();
		}

		// A second render may have started and destroyed this instance while the
		// layout was running -- opening the graph view twice in quick succession
		// is enough. Binding handlers to the old instance would leak them.
		if (token !== this.renderToken) return;

		// Click handler: highlight connected nodes, or release the highlight if
		// this node already holds it
		this.cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target as cytoscape.NodeSingular;
			if (this.selectedNodeId === node.id()) {
				this.resetHighlights();
				return;
			}
			this.highlightConnected(node);
		});

		// Double-click on node to search
		this.cy.on('dbltap', 'node', (evt: cytoscape.EventObject) => {
			const { name } = nodeData(evt.target as cytoscape.NodeSingular);
			if (name) {
				openSearchModal(this.plugin, name);
			}
		});

		// Cytoscape calls preventDefault on mousedown, which stops a click from
		// focusing the container the normal way -- and without focus the
		// container never sees Escape. Focus it explicitly on interaction.
		this.cy.on('tapstart', () => {
			this.graphContainer?.focus({ preventScroll: true });
		});

		// Any tap that is not on a node releases the highlight. Testing for the
		// background alone is not enough: a dense graph covers its own canvas
		// with edges, so most clicks that look like empty space land on an edge
		// and the user is left with no way back.
		this.cy.on('tap', (evt: cytoscape.EventObject) => {
			// evt.target is the core for a background tap and an element
			// otherwise; cytoscape's types don't express that union
			const target = evt.target as { isNode?: () => boolean };
			const onNode = typeof target.isNode === 'function' && target.isNode();
			if (!onNode) {
				this.resetHighlights();
				this.hideTooltip();
			}
		});

		// Hover effects for nodes
		this.cy.on('mouseover', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target as cytoscape.NodeSingular;
			node.addClass('hover');
			this.showNodeTooltip(node, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'node', (evt: cytoscape.EventObject) => {
			(evt.target as cytoscape.NodeSingular).removeClass('hover');
			this.hideTooltip();
		});

		// Hover effects for edges - show relationship type and detail
		this.cy.on('mouseover', 'edge', (evt: cytoscape.EventObject) => {
			this.showEdgeTooltip(evt.target as cytoscape.EdgeSingular, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'edge', () => {
			this.hideTooltip();
		});

		// Edge weight follows the zoom level; set it for the fitted view first
		this.updateEdgeWeight();
		this.cy.on('zoom', () => this.updateEdgeWeight());
	}

	private showNodeTooltip(node: cytoscape.NodeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const data = nodeData(node);
		const name = data.name;
		const entityType = data.entityType || data.label || '';
		const sourceNotes = data.sourceNotes || [];

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-label', text: entityType });
		this.tooltipEl.createDiv({ cls: 'tooltip-name', text: name });
		this.tooltipEl.createDiv({
			cls: 'tooltip-connections',
			text: `${data.degree} connection${data.degree === 1 ? '' : 's'}`,
		});
		if (sourceNotes.length > 0) {
			this.tooltipEl.createDiv({ cls: 'tooltip-sources', text: `Found in ${sourceNotes.length} note${sourceNotes.length > 1 ? 's' : ''}` });
		}

		this.tooltipEl.style.left = `${position.x + 15}px`;
		this.tooltipEl.style.top = `${position.y + 15}px`;
		this.tooltipEl.addClass('visible');
	}

	private showEdgeTooltip(edge: cytoscape.EdgeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const { relationship, detail } = edgeData(edge);

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
	private getLayoutConfig(nodeCount: number, elementCount: number): cytoscape.LayoutOptions {
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

		// Large graph: 'default' runs spectral placement AND a full CoSE
		// refinement; 'draft' stops after spectral. Past ~1000 nodes that
		// refinement costs tens of seconds to minutes, so refineDraftLayout()
		// substitutes for it -- repulsion happens there, not here (CoSE-only
		// options like nodeRepulsion are ignored under 'draft').
		if (nodeCount > DRAFT_LAYOUT_NODE_THRESHOLD) {
			return {
				...baseConfig,
				quality: 'draft',
				nodeDimensionsIncludeLabels: false,
				idealEdgeLength: () => 120,
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

	/**
	 * Position pass that runs after fCoSE: force refinement for large graphs,
	 * label-aware spacing for all of them.
	 *
	 * fCoSE 'draft' does spectral placement only. Spectral coordinates are
	 * derived from a handful of eigenvectors, so nodes with the same structural
	 * role -- every entity hanging off one note hub, say -- come out at
	 * *identical* coordinates. On a real 2263-node vault only ~4% of positions
	 * were distinct; that is the "everything clumps together" symptom. The
	 * CoSE pass that would separate them costs ~164s at 5000 nodes.
	 *
	 * An earlier repair (0.5.1) snapped the stacks onto a 60px grid. That made
	 * every node visible but applied no repulsion at all, so the graph rendered
	 * as a uniform lattice with edges criss-crossing the whole frame -- nothing
	 * like Obsidian's own force-directed view. refineLayout replaces it with a
	 * seeded ForceAtlas2 run (Gephi's force model, Barnes-Hut so O(n log n)
	 * per iteration, seconds at 2263 nodes).
	 *
	 * Smaller graphs keep their full-quality fCoSE positions -- `force: false`
	 * skips straight to the spacing pass, which only scales the layout out and
	 * separates what still overlaps. They need it: fCoSE packs an 871-node
	 * graph at a 42px median gap, leaving 5% of nodes with room for their
	 * label, and `nodeDimensionsIncludeLabels` does not change that.
	 *
	 * Runs in slices on the browser's frame scheduler, so the loading
	 * indicator stays live, and aborts via renderToken if a newer render
	 * supersedes this one mid-flight.
	 *
	 * @returns true when new positions were applied.
	 */
	private async refineLayoutPositions(token: number, force: boolean): Promise<boolean> {
		if (!this.cy) return false;

		// Spacing is the label budget on graphs small enough to show at a
		// legible scale, and shrinks on ones that are not -- see
		// spacingForNodeCount.
		const spacingRadius = spacingForNodeCount(this.cy.nodes().length) / 2;
		const nodes: LayoutNode[] = this.cy.nodes().map(node => {
			const p = node.position();
			return {
				id: node.id(),
				x: p.x,
				y: p.y,
				radius: Math.max(spacingRadius, nodeData(node).size / 2),
			};
		});
		const edges: LayoutEdge[] = this.cy.edges().map(edge => {
			const { source, target } = edgeData(edge);
			return { source, target };
		});

		const completed = await refineLayout(nodes, edges, {
			...(force ? {} : { structureTicks: 0 }),
			shouldStop: () => token !== this.renderToken || !this.cy,
		});
		if (!completed || token !== this.renderToken || !this.cy) return false;

		const positions = new Map(nodes.map(n => [n.id, n]));
		this.cy.batch(() => {
			// Block body: cytoscape's forEach treats a returned `false` as "stop"
			this.cy?.nodes().forEach(node => {
				const p = positions.get(node.id());
				if (p) node.position({ x: p.x, y: p.y });
			});
		});
		return true;
	}

	/**
	 * Swap edges between the bold overview weight and the light reading
	 * weight, following the zoom level.
	 *
	 * A mesh of thousands of edges has to be bold to register at all when it
	 * is fitted to the pane -- each edge covers a fraction of a pixel there.
	 * That same weight buries nodes and labels once the user zooms in, so it
	 * is dropped past EDGE_OVERVIEW_MAX_ZOOM. Only the transitions restyle, so
	 * panning and ordinary zooming cost nothing.
	 */
	private updateEdgeWeight(): void {
		if (!this.cy) return;
		const bold = this.cy.zoom() < EDGE_OVERVIEW_MAX_ZOOM;
		if (bold === this.edgesBold) return;
		this.edgesBold = bold;
		const edges = this.cy.edges();
		this.cy.batch(() => {
			if (bold) edges.addClass('overview');
			else edges.removeClass('overview');
		});
	}

	private highlightConnected(node: cytoscape.NodeSingular): void {
		if (!this.cy) return;

		// Batched: without this, each of the three class operations triggers its
		// own style recalculation and redraw across every element in the graph.
		this.selectedNodeId = node.id();
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

		this.selectedNodeId = null;

		// Scoped to what is actually marked. Every background tap used to sweep
		// the whole graph, even with nothing highlighted.
		const marked = this.cy.elements('.highlighted, .faded');
		if (marked.length === 0) return;
		marked.removeClass('highlighted faded');
	}

	onClose(): Promise<void> {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
		return Promise.resolve();
	}
}
