import { ItemView, WorkspaceLeaf, Notice, debounce } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { describeWhy } from '../commands/search';
import { getEntityTypeColor, normalizeKey } from '../types';
import { refineLayout, spacingForNodeCount, LayoutNode, LayoutEdge } from '../graph/layout';
import { LiveForces, LiveLayout } from '../graph/live-layout';
import { Point, PositionStore, REUSE_KNOWN_FRACTION, placeNewNodes } from '../graph/positions';
import { computeGraphVisualMetrics, countVisibleDegrees } from '../graph/visual-metrics';
import {
	DEFAULT_GRAPH_DISPLAY,
	GraphDisplaySettings,
	LAYOUT_KEYS,
	edgeLengthFactor,
	normalizeGraphDisplay,
} from '../graph/display';
import { ClusterResult, clusterColor, detectClusters } from '../graph/clusters';
import { GraphControlsPanel, GraphLegend } from './graph-controls';
import {
	GraphInspector,
	GraphSearchBar,
	InspectorRelation,
	NodeRow,
	PathStep,
	SearchResults,
} from './graph-explore';
import type { EntityHit, NoteHit } from '../query/types';

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

// ForceAtlas2 iterations for a layout from scratch -- the budget refineLayout
// ran synchronously before the layout moved into a worker -- and for settling
// newly added nodes around a remembered layout, which starts close to done.
const FULL_LAYOUT_ITERATIONS = 300;
const NEWCOMER_ITERATIONS = 100;

// While the layout settles, wait this many times a redraw's cost before the
// next one, which leaves the main thread at least 75% free; see pumpLive.
const REDRAW_IDLE_RATIO = 3;

// Zoom at which edges stop being drawn at overview weight. Labels appear at
// 0.8 (min-zoomed-font-size 8 over a 10px font), so the mesh has already
// thinned out by the time there is text to read behind it.
const EDGE_OVERVIEW_MAX_ZOOM = 0.5;

/** Visited nodes kept in the inspector's trail. */
const MAX_TRAIL = 12;

/** Ranked results asked of the search engine per query. */
const SEARCH_LIMIT = 30;

/**
 * Entities, and separately notes, reached through the graph without
 * matching the words. Kept apart from SEARCH_LIMIT so text matches can never
 * crowd them out. 15 + 15 fills the result list's 30 rows; further out the
 * walk's scores flatten into "everything a few steps away", and more dashed
 * rings than this stop reading as a set on a large graph.
 */
const REACHED_LIMIT = 15;

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
 *
 * `accent` marks search hits and paths; amber stays distinct from every
 * entity-type colour on both backgrounds.
 */
function themeColors(): { edge: string; label: string; highlight: string; accent: string } {
	return document.body.hasClass('theme-dark')
		? { edge: '#cbd5e1', label: '#a8a8a8', highlight: '#ffffff', accent: '#fbbf24' }
		: { edge: '#64748b', label: '#5c6370', highlight: '#1e1e1e', accent: '#d97706' };
}

/** The colour a node is drawn in under the current display settings. */
function nodeColor(data: GraphNodeData, display: GraphDisplaySettings): string {
	if (display.colorBy === 'cluster') return data.clusterColor;
	return display.typeColors[data.entityType ?? ''] ?? data.typeColor;
}

/**
 * Build the stylesheet. Edge rendering depends on graph size: bezier curves and
 * arrowheads are the two most expensive per-edge primitives, so large graphs
 * drop both. Everything the user can adjust comes in through `display`.
 */
function buildGraphStyles(isLargeGraph: boolean, display: GraphDisplaySettings): cytoscape.StylesheetStyle[] {
	const { edge: themeEdge, label: labelColor, highlight, accent } = themeColors();
	const edgeColor = display.edgeColor || themeEdge;
	const nodeSize = (node: cytoscape.NodeSingular): number => nodeData(node).size * display.nodeSize;
	const emphasizedNodeSize = (node: cytoscape.NodeSingular): number => nodeSize(node) + 4;
	const edgeOpacity = (edge: cytoscape.EdgeSingular): number =>
		Math.min(1, edgeData(edge).opacity * display.edgeOpacity);
	const overviewEdgeOpacity = (edge: cytoscape.EdgeSingular): number =>
		Math.min(1, edgeData(edge).overviewOpacity * display.edgeOpacity);

	// This is the weight edges are drawn at once the user has zoomed in far
	// enough to read the graph. A dense graph needs them lighter than a sparse
	// one here, or the mesh buries the nodes and their labels.
	const edgeStyle: cytoscape.Css.Edge = {
		'width': display.edgeWidth,
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

	if (display.edgeLabels) {
		edgeStyle['label'] = 'data(relationship)';
		edgeStyle['font-size'] = `${Math.max(6, display.labelSize - 2)}px`;
		edgeStyle['color'] = labelColor;
		edgeStyle['text-rotation'] = 'autorotate';
		// Same rule as node labels: never draw text too small to read
		edgeStyle['min-zoomed-font-size'] = 8;
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
				'font-size': `${display.labelSize}px`,
				'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
				'color': labelColor,
				'text-wrap': 'ellipsis',
				// 80px at the default 10px font; scales with the font
				'text-max-width': `${display.labelSize * 8}px`,
				// Stop measuring and drawing labels once they'd be unreadable
				// anyway. This is what keeps the zoomed-out view responsive, and
				// it's how Obsidian's own graph behaves.
				'min-zoomed-font-size': 8,
				'width': nodeSize,
				'height': nodeSize,
				'border-width': 0,
				'background-opacity': display.nodeOpacity,
				'background-color': (node: cytoscape.NodeSingular) => nodeColor(nodeData(node), display),
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
				'width': 1.4 * display.edgeWidth,
				'opacity': overviewEdgeOpacity,
			},
		},
		// Filtered out by type, or outside the focused neighbourhood. Cytoscape
		// hides a hidden node's edges along with it.
		{
			selector: '.type-hidden, .out-of-focus',
			style: {
				'display': 'none',
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
				'width': 2 * display.edgeWidth,
				'opacity': 1,
			},
		},
		// Faded state (non-selected elements)
		// Faded through the fill, border and text opacities rather than
		// 'opacity': the WebGL renderer draws plain nodes as SDF shapes that
		// read background-opacity and ignore element opacity, so 'opacity'
		// faded only the nodes it happened to draw from textures
		{
			selector: 'node.faded',
			style: {
				'background-opacity': 0.15 * display.nodeOpacity,
				'border-opacity': 0.15,
				'text-opacity': 0.15,
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
		// Search hits: a solid ring for what matched the words, a dashed one
		// for what the graph walk reached from there
		{
			selector: 'node.search-match',
			style: {
				'border-width': 3,
				'border-color': accent,
				'border-style': 'solid',
			},
		},
		{
			selector: 'node.search-related',
			style: {
				'border-width': 2,
				'border-color': accent,
				'border-style': 'dashed',
			},
		},
		{
			selector: 'edge.on-path',
			style: {
				'width': 3 * display.edgeWidth,
				'line-color': accent,
				'target-arrow-color': accent,
				'opacity': 1,
				'z-index': 10,
			},
		},
		{
			selector: 'node.on-path',
			style: {
				'border-width': 3,
				'border-color': accent,
			},
		},
		{
			selector: 'node.selected',
			style: {
				'border-width': 4,
				'border-color': highlight,
				'z-index': 999,
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
	typeColor: string;
	/** Index into the current ClusterResult, -1 when unclustered. */
	cluster: number;
	clusterColor: string;
	description?: string;
	sourceNotes: string[];
	/** normalizeKey of the name, for the in-graph name search. */
	searchKey: string;
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

function isNoteNode(data: GraphNodeData): boolean {
	return data.entityType === 'NOTE';
}

// ============================================
// Graph View
// ============================================

export class GraphView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	cy: cytoscape.Core | null = null;
	private graphContainer: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private controls: GraphControlsPanel | null = null;
	private searchBar: GraphSearchBar | null = null;
	private inspector: GraphInspector | null = null;
	/** Guards against overlapping renders; see renderGraph. */
	private renderToken = 0;
	/** Bumped by every layout run, so a newer one cancels an older refinement. */
	private layoutToken = 0;
	/** Bumped per search, so a slow result never overwrites a newer one. */
	private searchGeneration = 0;
	private readonly positionStore: PositionStore;
	/** The force layout settling in a worker, if one is running. */
	private live: LiveLayout | null = null;
	private liveFrame: number | null = null;
	/** The last live redraw, timed over the frames after it; see pumpLive. */
	private drawTiming: { start: number; frames: number } | null = null;
	private nextDrawAt = 0;
	/** Rendered nodes by id, so each live frame skips cytoscape's selector lookup. */
	private liveNodes = new Map<string, cytoscape.NodeSingular>();
	/**
	 * Keep the settling layout fitted to the pane. Off as soon as the user
	 * zooms, drags the view or jumps to a node, so it never fights them.
	 */
	private autoFit = true;
	/** Whether edges currently carry the bold overview weight; see updateEdgeWeight. */
	private edgesBold = false;
	private isLargeGraph = false;
	private display: GraphDisplaySettings;
	private clusters: ClusterResult = { clusterOf: new Map(), clusters: [] };
	/** Vault path -> NOTE node id, for placing note search hits in the graph. */
	private noteNodeByPath = new Map<string, string>();

	// Exploration state. applyEmphasis turns all of it into element classes.
	/** Node the inspector shows and the highlight is anchored to, if any. */
	private selectedNodeId: string | null = null;
	/** Nodes selected before the current one, oldest first. */
	private trail: string[] = [];
	/** Show only this many hops around the selection; 0 shows everything. */
	private focusHops = 0;
	private searchMatches = new Set<string>();
	private searchRelated = new Set<string>();
	/** Whether a result list is up: typed query, cluster, or "search around". */
	private searchActive = false;
	/** Set by "Path to…": the next node picked becomes the path's goal. */
	private pickingPath = false;
	private path: { nodes: string[]; edges: string[] } | null = null;

	private styleFrame: number | null = null;
	private readonly saveDisplay = debounce(() => {
		this.plugin.settings.graphDisplay = this.display;
		void this.plugin.saveSettings();
	}, 500, true);
	private readonly scheduleRelayout = debounce(() => this.relayout(), 300, true);
	private readonly scheduleSavePositions = debounce(() => {
		const existing = new Set(this.plugin.graphCache.getGraphData().nodes.map(node => node.id));
		this.positionStore.save(existing).catch(e => console.error('[simple-graph-builder] could not save graph layout', e));
	}, 1000, true);
	private readonly scheduleRender = debounce(() => {
		void this.plugin.saveSettings();
		void this.renderGraph();
	}, 300, true);
	private readonly scheduleEngineSearch = debounce((query: string, generation: number) => {
		void this.engineSearch(query, generation);
	}, 200, true);

	constructor(leaf: WorkspaceLeaf, plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.display = normalizeGraphDisplay(plugin.settings.graphDisplay);
		// Beside data.json rather than in it: positions change on every
		// layout, and data.json is rewritten whole on every settings save
		const adapter = plugin.app.vault.adapter;
		const path = `${plugin.manifest.dir ?? `${plugin.app.vault.configDir}/plugins/${plugin.manifest.id}`}/graph-layout.json`;
		this.positionStore = new PositionStore({
			read: async () => (await adapter.exists(path)) ? adapter.read(path) : null,
			write: text => adapter.write(path, text),
		});
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
			// Only swallow the key when it actually released something, so
			// Escape still closes the pane otherwise
			if (evt.key === 'Escape' && this.releaseOne()) {
				this.hideTooltip();
				evt.preventDefault();
			}
		});

		// Create tooltip element (positioned absolutely, won't affect layout)
		// Styles defined in styles.css via .graph-tooltip class
		this.tooltipEl = container.createDiv({ cls: 'graph-tooltip' });

		// Overlays sit beside the cytoscape container rather than in it, so they
		// survive the re-render that empties it
		const left = container.createDiv({ cls: 'sgb-graph-overlay-left' });
		this.searchBar = new GraphSearchBar(left, {
			onQuery: query => this.search(query),
			onClear: () => this.clearSearch(),
			onPick: row => this.pick(row),
			onOpenNote: path => void this.openNote(path),
			onToggleControls: () => this.controls?.toggle(),
			onFit: () => this.fitToFocus(),
		});
		this.inspector = new GraphInspector(left, {
			onNavigate: row => this.pick(row),
			onOpenNote: path => void this.openNote(path),
			onClose: () => this.deselect(),
			onFocusHops: hops => this.setFocusHops(hops),
			onSearchAround: () => {
				if (this.selectedNodeId) void this.searchAround(this.selectedNodeId);
			},
			onPathStart: () => {
				this.pickingPath = true;
				this.path = null;
				this.applyEmphasis();
				this.renderInspector();
			},
			onPathCancel: () => {
				this.pickingPath = false;
				this.renderInspector();
			},
		});
		this.controls = new GraphControlsPanel(container, this.plugin.settings, this.display, {
			onDisplayChange: key => this.onDisplayChange(key),
			onFilterChange: () => this.scheduleRender(),
			onClusterSelect: index => this.showCluster(index),
			onRelayout: () => this.relayout(),
			onReset: () => this.resetDisplay(),
		});
		this.statusEl = container.createDiv({ cls: 'sgb-graph-status' });
		this.statusEl.hide();

		// Note hits need the text index, which nothing else may have built
		// yet. Build it in the background and re-run a query typed meanwhile.
		void this.plugin.queryEngine.ensureIndexed().then(() => {
			const query = this.searchBar?.query.trim();
			if (query) this.search(query);
		});

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
		this.stopLive();
		this.autoFit = true;

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
			this.resetExploration();
			return;
		}

		const totalElements = graph.nodes.length + graph.edges.length;
		const isLargeGraph = totalElements > LARGE_GRAPH_THRESHOLD;
		this.isLargeGraph = isLargeGraph;

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

		// Clusters too: Louvain over what is on screen, so a hidden note layer
		// doesn't hold together a cluster the user can't see the reason for
		this.clusters = detectClusters(
			nodesToRender.map(node => node.id),
			edgesToRender,
			this.display.clusterResolution
		);

		// Open on the remembered layout when most of the graph has one; place
		// only what is new beside its neighbours
		await this.positionStore.load();
		if (token !== this.renderToken) return;
		const remembered = new Map<string, Point>();
		for (const node of nodesToRender) {
			const p = this.positionStore.get(node.id);
			if (p) remembered.set(node.id, p);
		}
		const reuse = remembered.size > 0 && remembered.size >= REUSE_KNOWN_FRACTION * nodesToRender.length;
		const placed = reuse
			? placeNewNodes(
				nodesToRender.map(node => node.id),
				edgesToRender,
				remembered,
				this.display.spacing * spacingForNodeCount(nodesToRender.length),
			)
			: new Map<string, Point>();

		const elements: cytoscape.ElementDefinition[] = [];
		this.noteNodeByPath = new Map();

		// Add nodes with entity type colors
		for (const node of nodesToRender) {
			const metric = visualMetrics.nodes.get(node.id)!;
			const cluster = this.clusters.clusterOf.get(node.id) ?? -1;
			const description = node.properties.description;
			if (node.entityType === 'NOTE' && node.sourceNotes[0]) {
				this.noteNodeByPath.set(node.sourceNotes[0], node.id);
			}
			const data: GraphNodeData = {
				id: node.id,
				name: node.properties.name,
				entityType: node.entityType,
				label: node.label || node.entityType, // fallback for legacy
				typeColor: getEntityTypeColor(node.entityType || node.label),
				cluster,
				clusterColor: clusterColor(cluster),
				description: typeof description === 'string' ? description : undefined,
				sourceNotes: node.sourceNotes,
				searchKey: normalizeKey(node.properties.name),
				degree: metric.degree,
				size: metric.size,
				emphasizedSize: metric.emphasizedSize,
			};
			const position = reuse ? remembered.get(node.id) ?? placed.get(node.id) : undefined;
			elements.push(position ? { data, position: { x: position.x, y: position.y } } : { data });
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
			style: buildGraphStyles(isLargeGraph, this.display),
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

		// Fresh instance: no edge carries the overview class yet
		this.edgesBold = false;
		this.applyTypeVisibility();

		if (reuse) {
			// Nothing to wait for: the graph is where the user left it
			this.cy.fit(this.cy.elements(':visible'), 30);
			loadingEl?.remove();
		} else {
			try {
				await this.seedLayout();
			} finally {
				// Even on a layout error the indicator has to go, or the view is
				// stuck showing "Loading graph..." forever
				loadingEl?.remove();
			}
			if (token === this.renderToken) this.cy?.fit(this.cy.elements(':visible'), 30);
		}

		// A second render may have started and destroyed this instance while the
		// layout was running -- opening the graph view twice in quick succession
		// is enough. Binding handlers to the old instance would leak them.
		if (token !== this.renderToken) return;

		this.bindEvents(this.cy);

		// Edge weight follows the zoom level; set it for the fitted view first
		this.updateEdgeWeight();
		this.cy.on('zoom', () => this.updateEdgeWeight());

		this.updateLegend();
		this.restoreExploration();

		// Settle in a worker while the user already has the graph: all of it
		// from the seed, or just the newcomers around the remembered frame
		if (!reuse) this.startLive(FULL_LAYOUT_ITERATIONS);
		else if (placed.size > 0) this.startLive(NEWCOMER_ITERATIONS, new Set(remembered.keys()));
	}

	private bindEvents(cy: cytoscape.Core): void {
		// Click a node to select it, or to release it if it already holds the
		// selection. While choosing a path's goal, the click picks the goal.
		//
		// The release waits for 'onetap', which cytoscape fires only once it
		// knows the tap isn't half of a double-click. Releasing on 'tap' made
		// a double-click select, release (dropping the trail), then search.
		let pendingRelease: string | null = null;
		cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target as cytoscape.NodeSingular;
			pendingRelease = null;
			if (this.pickingPath && this.selectedNodeId && this.selectedNodeId !== node.id()) {
				this.showPathTo(node.id());
				return;
			}
			if (this.selectedNodeId === node.id()) {
				pendingRelease = node.id();
				return;
			}
			this.selectNode(node.id(), false);
		});
		cy.on('onetap', 'node', (evt: cytoscape.EventObject) => {
			if (pendingRelease === (evt.target as cytoscape.NodeSingular).id()) this.deselect();
			pendingRelease = null;
		});

		// Double-click on a node: rank everything by its connection to it
		cy.on('dbltap', 'node', (evt: cytoscape.EventObject) => {
			pendingRelease = null;
			void this.searchAround((evt.target as cytoscape.NodeSingular).id());
		});

		// Cytoscape calls preventDefault on mousedown, which stops a click from
		// focusing the container the normal way -- and without focus the
		// container never sees Escape. Focus it explicitly on interaction.
		cy.on('tapstart', () => {
			this.graphContainer?.focus({ preventScroll: true });
			this.autoFit = false;
		});
		cy.on('scrollzoom pinchzoom', () => {
			this.autoFit = false;
		});

		// A node the user drags stays where they put it. Mid-layout the worker
		// still has its old position, so the layout restarts from the new one.
		cy.on('free', 'node', () => {
			if (this.live) this.startLive(NEWCOMER_ITERATIONS);
			else this.savePositions();
		});

		// Any tap that is not on a node releases the selection. Testing for the
		// background alone is not enough: a dense graph covers its own canvas
		// with edges, so most clicks that look like empty space land on an edge
		// and the user is left with no way back.
		cy.on('tap', (evt: cytoscape.EventObject) => {
			// evt.target is the core for a background tap and an element
			// otherwise; cytoscape's types don't express that union
			const target = evt.target as { isNode?: () => boolean };
			const onNode = typeof target.isNode === 'function' && target.isNode();
			if (!onNode) {
				this.deselect();
				this.hideTooltip();
			}
		});

		// Hover effects for nodes
		cy.on('mouseover', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target as cytoscape.NodeSingular;
			node.addClass('hover');
			this.showNodeTooltip(node, evt.renderedPosition);
		});

		cy.on('mouseout', 'node', (evt: cytoscape.EventObject) => {
			(evt.target as cytoscape.NodeSingular).removeClass('hover');
			this.hideTooltip();
		});

		// Hover effects for edges - show relationship type and detail
		cy.on('mouseover', 'edge', (evt: cytoscape.EventObject) => {
			this.showEdgeTooltip(evt.target as cytoscape.EdgeSingular, evt.renderedPosition);
		});

		cy.on('mouseout', 'edge', () => {
			this.hideTooltip();
		});
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

	// ============================================
	// Layout
	// ============================================

	/**
	 * Spectral placement: fCoSE 'draft', sub-second at every size measured.
	 *
	 * It is only a seed. Spectral coordinates come from a handful of
	 * eigenvectors, so structurally equivalent nodes -- every entity hanging
	 * off one note hub -- land on identical points; on a real 2263-node vault
	 * only ~4% of positions were distinct. The live ForceAtlas2 run that
	 * follows pulls them apart into clusters.
	 *
	 * Full-quality fCoSE used to lay out graphs under 1000 nodes. Draft plus
	 * FA2 beat it at every size on the layout suite's synthetic vaults, on
	 * both neighbourhood preservation (0.41 vs 0.16 at 278 nodes, 0.19 vs 0.05
	 * at 1222) and cluster separation (0.38 vs 0.48, 0.22 vs 0.39), in a
	 * quarter of the time at 1222 nodes -- and FA2 runs off the main thread.
	 */
	private async seedLayout(): Promise<void> {
		const cy = this.cy;
		if (!cy) return;
		const layout = cy.layout({
			name: 'fcose',
			quality: 'draft',
			animate: false,
			randomize: true,
			tile: true,
			nodeDimensionsIncludeLabels: false,
			idealEdgeLength: () => 120,
			tilingPaddingVertical: 30,
			tilingPaddingHorizontal: 30,
		} as cytoscape.LayoutOptions);
		const settled = layout.promiseOn('layoutstop');
		layout.run();
		await settled;
	}

	/**
	 * The rendered graph as layout input: positions, the clearance each node
	 * needs, and per-edge FA2 weights.
	 *
	 * Spacing is the label budget on graphs small enough to show at a legible
	 * scale and shrinks on ones that are not (spacingForNodeCount); the
	 * display's spacing setting scales it. Link length and cluster pull become
	 * attraction weights: FA2 settles an edge at a length that goes as
	 * 1/sqrt(weight), so weight 1/factor^2 scales it by the factor.
	 */
	private layoutInput(): { nodes: LayoutNode[]; edges: LayoutEdge[] } {
		const cy = this.cy;
		if (!cy) return { nodes: [], edges: [] };
		const display = this.display;
		const spacingRadius = display.spacing * spacingForNodeCount(cy.nodes().length) / 2;
		const nodes: LayoutNode[] = cy.nodes().map(node => {
			const p = node.position();
			return {
				id: node.id(),
				x: p.x,
				y: p.y,
				radius: Math.max(spacingRadius, nodeData(node).size * display.nodeSize / 2),
			};
		});
		const edges: LayoutEdge[] = cy.edges().map(edge => {
			const { source, target } = edgeData(edge);
			const a = nodeData(edge.source()).cluster;
			const factor = edgeLengthFactor(display, a >= 0 && a === nodeData(edge.target()).cluster);
			return { source, target, weight: 1 / (factor * factor) };
		});
		return { nodes, edges };
	}

	private liveForces(): LiveForces {
		return {
			scalingRatio: 30 * this.display.repulsion,
			gravity: 0.05 * this.display.gravity,
		};
	}

	/**
	 * Run ForceAtlas2 in a worker from the current positions, drawing each
	 * frame as it goes. `fixed` nodes hold still while the others settle.
	 */
	private startLive(iterations: number, fixed?: ReadonlySet<string>): void {
		const cy = this.cy;
		if (!cy) return;
		this.stopLive();
		const { nodes, edges } = this.layoutInput();
		if (nodes.length < 2) return;

		let live: LiveLayout;
		try {
			live = new LiveLayout(nodes, edges, { ...this.liveForces(), maxIterations: iterations, fixed });
		} catch (e) {
			// No worker (blocked, or out of resources): settle synchronously
			// instead, the way every layout ran before
			console.error('[simple-graph-builder] live layout unavailable', e);
			void this.settleWithoutWorker(iterations);
			return;
		}
		this.live = live;
		this.liveNodes = new Map(cy.nodes().map(node => [node.id(), node]));
		this.drawTiming = null;
		this.nextDrawAt = 0;
		live.start();
		this.showLayoutStatus();
		this.pumpLive();
	}

	/**
	 * Copy the worker's positions into the graph as often as the redraw
	 * allows, until it is done.
	 *
	 * Moving every node costs cytoscape far more to redraw than to update:
	 * on 2001 nodes / 10368 edges, 5-8ms to set the positions, then two
	 * frames of ~240ms each (~60% of it the edges). Drawing every frame
	 * saturated the main thread at 4fps. So each draw is timed over the two
	 * frames after it, and the next waits REDRAW_IDLE_RATIO times that: a
	 * small graph animates smoothly, a large one updates every second or so,
	 * and the view stays responsive either way.
	 */
	private pumpLive(): void {
		this.liveFrame = window.requestAnimationFrame(() => {
			this.liveFrame = null;
			const live = this.live;
			const cy = this.cy;
			if (!live || !cy) return;
			const now = performance.now();

			if (this.drawTiming) {
				if (++this.drawTiming.frames >= 2) {
					this.nextDrawAt = now + REDRAW_IDLE_RATIO * (now - this.drawTiming.start);
					this.drawTiming = null;
				}
			} else if (live.done || (now >= this.nextDrawAt && live.takeFresh())) {
				cy.batch(() => {
					live.forEachPosition((id, x, y) => {
						const node = this.liveNodes.get(id);
						// A node the user is holding stays under the pointer.
						// Never a non-finite position: one NaN in the layout
						// input stalls the spacing pass's grid indefinitely.
						if (node && !node.grabbed() && Number.isFinite(x) && Number.isFinite(y)) node.position({ x, y });
					});
				});
				// The layout grows and shrinks as it settles; keep it in view
				// until the user takes the viewport over
				if (this.autoFit) this.frame(cy.elements(':visible'), 30, false);
				if (live.done) {
					void this.finishLive(live.failed);
					return;
				}
				this.drawTiming = { start: now, frames: 0 };
			}
			this.pumpLive();
		});
	}

	/** End a live run without finishing it: a newer render or layout replaces it. */
	private stopLive(): void {
		if (this.liveFrame !== null) window.cancelAnimationFrame(this.liveFrame);
		this.liveFrame = null;
		this.live?.kill();
		this.live = null;
		this.liveNodes = new Map();
		this.statusEl?.hide();
	}

	/** Spacing pass on the settled positions, then fit and remember them. */
	private async finishLive(workerFailed = false): Promise<void> {
		this.stopLive();
		if (workerFailed) {
			await this.settleWithoutWorker(FULL_LAYOUT_ITERATIONS);
			return;
		}
		const token = ++this.layoutToken;
		if (await this.applySpacing(token)) {
			if (this.autoFit && this.cy) this.frame(this.cy.elements(':visible'), 30);
			this.savePositions();
		}
	}

	/** The pre-worker path: FA2 in slices on the main thread, then spacing. */
	private async settleWithoutWorker(iterations: number): Promise<void> {
		const cy = this.cy;
		if (!cy) return;
		const token = ++this.layoutToken;
		const { nodes, edges } = this.layoutInput();
		const completed = await refineLayout(nodes, edges, {
			...this.liveForces(),
			structureTicks: iterations,
			shouldStop: () => token !== this.layoutToken || !this.cy,
		});
		if (!completed || token !== this.layoutToken || !this.cy) return;
		this.applyPositions(nodes);
		if (this.autoFit) this.frame(cy.elements(':visible'), 30);
		this.savePositions();
	}

	/** Re-run the force layout from the current positions, e.g. after a force changed. */
	private relayout(): void {
		if (!this.cy) return;
		this.autoFit = true;
		this.startLive(FULL_LAYOUT_ITERATIONS);
	}

	private showLayoutStatus(): void {
		const status = this.statusEl;
		if (!status) return;
		status.empty();
		status.createSpan({ text: 'Settling layout… ' });
		const stop = status.createEl('a', { text: 'Stop', cls: 'sgb-graph-status-stop' });
		stop.addEventListener('click', evt => {
			evt.preventDefault();
			this.live?.stop();
		});
		status.show();
	}

	/**
	 * Label-aware spacing: scale the layout out until typical spacing clears
	 * the labels, then push apart whatever still overlaps, then pack
	 * disconnected components (refineLayout with no force iterations). FA2
	 * packs dense cores tighter than a label needs; this runs once the forces
	 * have settled, so it never fights them.
	 *
	 * @returns true when new positions were applied.
	 */
	private async applySpacing(token: number): Promise<boolean> {
		if (!this.cy) return false;
		const { nodes, edges } = this.layoutInput();
		const completed = await refineLayout(nodes, edges, {
			structureTicks: 0,
			shouldStop: () => token !== this.layoutToken || !this.cy,
		});
		if (!completed || token !== this.layoutToken || !this.cy) return false;
		this.applyPositions(nodes);
		return true;
	}

	private applyPositions(nodes: readonly LayoutNode[]): void {
		const cy = this.cy;
		if (!cy) return;
		const positions = new Map(nodes.map(n => [n.id, n]));
		cy.batch(() => {
			// Block body: cytoscape's forEach treats a returned `false` as "stop"
			cy.nodes().forEach(node => {
				const p = positions.get(node.id());
				if (p) node.position({ x: p.x, y: p.y });
			});
		});
	}

	/** Remember where every rendered node is, for the next render. */
	private savePositions(): void {
		const cy = this.cy;
		if (!cy) return;
		this.positionStore.update(cy.nodes().map(node => [node.id(), node.position()] as [string, Point]));
		this.scheduleSavePositions();
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

	// ============================================
	// Display settings
	// ============================================

	private onDisplayChange(key: keyof GraphDisplaySettings): void {
		this.saveDisplay();
		if (key === 'hiddenTypes') {
			this.applyTypeVisibility();
			this.applyEmphasis();
			return;
		}
		if (key === 'clusterResolution') {
			this.recluster();
			if (this.display.clusterPull > 0) this.scheduleRelayout();
			return;
		}
		// Repulsion and gravity reach a running layout on its next iteration;
		// the rest are baked into its edges and need a fresh run
		if ((key === 'repulsion' || key === 'gravity') && this.live) {
			this.live.setForces(this.liveForces());
			return;
		}
		if (LAYOUT_KEYS.has(key)) {
			this.scheduleRelayout();
			return;
		}
		this.scheduleRestyle();
		// Swatches in the inspector follow the node colours
		if (key === 'colorBy' || key === 'typeColors') this.renderInspector();
	}

	/** Rebuild the stylesheet at most once per frame while a slider is dragged. */
	private scheduleRestyle(): void {
		if (this.styleFrame !== null) return;
		this.styleFrame = window.requestAnimationFrame(() => {
			this.styleFrame = null;
			this.cy?.style().fromJson(buildGraphStyles(this.isLargeGraph, this.display)).update();
		});
	}

	private applyTypeVisibility(): void {
		const cy = this.cy;
		if (!cy) return;
		const hidden = new Set(this.display.hiddenTypes);
		cy.batch(() => {
			cy.nodes().forEach(node => {
				const type = nodeData(node).entityType ?? '';
				if (hidden.has(type)) node.addClass('type-hidden');
				else node.removeClass('type-hidden');
			});
		});
		// A hidden selection can't stay selected
		if (this.selectedNodeId && cy.getElementById(this.selectedNodeId).hasClass('type-hidden')) {
			this.deselect();
		}
	}

	/** Detect clusters again at the current resolution and recolour. */
	private recluster(): void {
		const cy = this.cy;
		if (!cy) return;
		this.clusters = detectClusters(
			cy.nodes().map(node => node.id()),
			cy.edges().map(edge => ({ source: edge.source().id(), target: edge.target().id() })),
			this.display.clusterResolution
		);
		cy.batch(() => {
			cy.nodes().forEach(node => {
				const cluster = this.clusters.clusterOf.get(node.id()) ?? -1;
				node.data({ cluster, clusterColor: clusterColor(cluster) });
			});
		});
		this.scheduleRestyle();
		this.updateLegend();
		this.renderInspector();
	}

	private resetDisplay(): void {
		this.display = normalizeGraphDisplay(DEFAULT_GRAPH_DISPLAY);
		this.saveDisplay();
		this.controls?.setDisplay(this.display);
		this.applyTypeVisibility();
		this.recluster();
		this.relayout();
	}

	/** Tell the control panel which types and clusters are on screen. */
	private updateLegend(): void {
		const cy = this.cy;
		if (!cy || !this.controls) return;

		const types = new Map<string, { count: number; builtInColor: string }>();
		cy.nodes().forEach(node => {
			const data = nodeData(node);
			const type = data.entityType ?? '';
			const entry = types.get(type);
			if (entry) entry.count++;
			else types.set(type, { count: 1, builtInColor: data.typeColor });
		});

		const legend: GraphLegend = {
			types: [...types.entries()]
				.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
				.map(([type, { count, builtInColor }]) => ({
					type,
					count,
					builtInColor,
					color: this.display.typeColors[type] ?? builtInColor,
				})),
			clusters: this.clusters.clusters.map(cluster => ({
				index: cluster.index,
				name: this.clusterName(cluster.members),
				size: cluster.members.length,
				color: clusterColor(cluster.index),
			})),
			themeEdgeColor: themeColors().edge,
		};
		this.controls.setLegend(legend);
	}

	/**
	 * Name a cluster after its best-connected entity. Notes are passed over
	 * when there is an entity to name it by: a cluster is about what the
	 * notes discuss.
	 */
	private clusterName(members: string[]): string {
		const cy = this.cy;
		if (!cy) return '';
		let best: GraphNodeData | null = null;
		for (const id of members) {
			const data = nodeData(cy.getElementById(id));
			if (!best
				|| (isNoteNode(best) && !isNoteNode(data))
				|| (isNoteNode(best) === isNoteNode(data) && data.degree > best.degree)) {
				best = data;
			}
		}
		return best?.name ?? '';
	}

	// ============================================
	// Exploration: selection, focus, search, paths
	// ============================================

	private rowFor(node: cytoscape.NodeSingular, reason?: string): NodeRow {
		const data = nodeData(node);
		return {
			id: node.hasClass('type-hidden') ? null : data.id,
			name: data.name,
			type: data.entityType || data.label || '',
			color: nodeColor(data, this.display),
			reason,
			notePath: isNoteNode(data) ? data.sourceNotes[0] : undefined,
		};
	}

	/** Jump to a node picked from a list, or close a path onto it. */
	private pick(row: NodeRow): void {
		if (!row.id) return;
		if (this.pickingPath && this.selectedNodeId && row.id !== this.selectedNodeId) {
			this.showPathTo(row.id);
			return;
		}
		this.selectNode(row.id, true);
	}

	/**
	 * Select a node and show it in the inspector. Moving from one selection
	 * to another extends the trail; returning to a node already on it cuts
	 * the trail back to that point, like a browser's back stack.
	 */
	private selectNode(id: string, center: boolean): void {
		const cy = this.cy;
		if (!cy) return;
		const node = cy.getElementById(id);
		if (node.empty()) return;

		const previous = this.selectedNodeId;
		if (previous && previous !== id) {
			const back = this.trail.indexOf(id);
			if (back >= 0) {
				this.trail = this.trail.slice(0, back);
			} else {
				this.trail.push(previous);
				if (this.trail.length > MAX_TRAIL) this.trail.shift();
			}
		}
		this.selectedNodeId = id;
		this.pickingPath = false;
		this.path = null;
		this.applyEmphasis();
		this.renderInspector();

		if (this.focusHops > 0) {
			this.frame(cy.elements(':visible'), 40);
		} else if (center) {
			this.centerOn(node);
		}
	}

	private deselect(): void {
		if (this.selectedNodeId === null && !this.pickingPath && !this.path) return;
		this.selectedNodeId = null;
		this.trail = [];
		this.focusHops = 0;
		this.pickingPath = false;
		this.path = null;
		this.applyEmphasis();
		this.renderInspector();
	}

	/** Undo the most recent thing that narrows the view. Returns false if there was none. */
	private releaseOne(): boolean {
		if (this.pickingPath) {
			this.pickingPath = false;
			this.renderInspector();
			return true;
		}
		if (this.path) {
			this.path = null;
			this.applyEmphasis();
			this.renderInspector();
			return true;
		}
		if (this.selectedNodeId !== null) {
			this.deselect();
			return true;
		}
		if (this.searchActive) {
			this.searchBar?.clear();
			return true;
		}
		return false;
	}

	private setFocusHops(hops: number): void {
		this.focusHops = hops;
		this.applyEmphasis();
		this.renderInspector();
		this.fitToFocus();
	}

	/** Fit whatever the user is looking at: a path, a selection, search hits, or everything. */
	private fitToFocus(): void {
		const cy = this.cy;
		if (!cy) return;
		let target = cy.elements('.highlighted:visible');
		if (target.empty()) target = cy.elements(':visible');
		this.frame(target, 40);
	}

	/**
	 * The part of the pane the overlay panels leave uncovered, in rendered
	 * pixels. In a pane too narrow to spare the room, the whole pane: the
	 * panels cover the graph there whatever the framing.
	 */
	private openArea(): { left: number; right: number; top: number; bottom: number } {
		const container = this.graphContainer;
		const width = container?.clientWidth ?? 0;
		const height = container?.clientHeight ?? 0;
		const area = { left: 0, right: width, top: 0, bottom: height };
		if (!container) return area;
		const origin = container.getBoundingClientRect();
		const covering = [
			this.inspector?.el,
			this.searchBar?.el.querySelector<HTMLElement>('.sgb-graph-search-results'),
		].filter((el): el is HTMLElement => !!el && el.isShown());
		for (const el of covering) area.left = Math.max(area.left, el.getBoundingClientRect().right - origin.left);
		if (this.controls?.isOpen()) area.right = Math.min(area.right, this.controls.el.getBoundingClientRect().left - origin.left);
		if (area.right - area.left >= 240) return area;

		// Too narrow to frame beside the panels: they span the pane, search
		// at the top and the inspector docked at the bottom, so frame between
		const between = { left: 0, right: width, top: 0, bottom: height };
		const results = this.searchBar?.el.querySelector<HTMLElement>('.sgb-graph-search-results');
		const top = results?.isShown() ? results : this.searchBar?.el;
		if (top) between.top = top.getBoundingClientRect().bottom - origin.top;
		if (this.inspector?.el.isShown()) between.bottom = this.inspector.el.getBoundingClientRect().top - origin.top;
		if (between.bottom - between.top < 120) return { left: 0, right: width, top: 0, bottom: height };
		return between;
	}

	/** Fit `eles` into the uncovered part of the pane. */
	private frame(eles: cytoscape.CollectionReturnValue, padding: number, animate = true): void {
		const cy = this.cy;
		if (!cy || eles.empty()) return;
		const area = this.openArea();
		const bb = eles.boundingBox();
		const w = Math.max(1, area.right - area.left - 2 * padding);
		const h = Math.max(1, area.bottom - area.top - 2 * padding);
		// Never zoom in past 2 to frame a handful of nodes
		const zoom = Math.max(cy.minZoom(), Math.min(2, cy.maxZoom(), w / Math.max(bb.w, 1), h / Math.max(bb.h, 1)));
		const pan = {
			x: area.left + padding + (w - bb.w * zoom) / 2 - bb.x1 * zoom,
			y: area.top + padding + (h - bb.h * zoom) / 2 - bb.y1 * zoom,
		};
		if (animate) {
			// Framing on purpose ends the settling layout's auto-fit
			this.autoFit = false;
			cy.animate({ zoom, pan }, { duration: 250 });
		} else {
			cy.viewport({ zoom, pan });
		}
	}

	/** Centre a node in the uncovered part of the pane, zooming in to reading scale. */
	private centerOn(node: cytoscape.NodeSingular): void {
		const cy = this.cy;
		if (!cy) return;
		const area = this.openArea();
		const zoom = Math.max(cy.zoom(), 1);
		const p = node.position();
		const pan = {
			x: (area.left + area.right) / 2 - p.x * zoom,
			y: (area.top + area.bottom) / 2 - p.y * zoom,
		};
		this.autoFit = false;
		cy.animate({ zoom, pan }, { duration: 250 });
	}

	/**
	 * Turn the exploration state into element classes, in one batch.
	 *
	 * The precedence: a path outranks the selection, which outranks search
	 * results, for what is lit and what is faded. Search rings stay drawn
	 * underneath either, so the user can see which neighbours also matched.
	 */
	private applyEmphasis(): void {
		const cy = this.cy;
		if (!cy) return;
		cy.batch(() => {
			cy.elements().removeClass('highlighted faded search-match search-related selected on-path out-of-focus');

			const selected = this.selectedNodeId ? cy.getElementById(this.selectedNodeId) : cy.collection();

			if (selected.nonempty() && this.focusHops > 0) {
				let keep = selected.closedNeighborhood();
				for (let hop = 1; hop < this.focusHops; hop++) keep = keep.closedNeighborhood();
				cy.elements().difference(keep).addClass('out-of-focus');
			}

			for (const id of this.searchMatches) cy.getElementById(id).addClass('search-match');
			for (const id of this.searchRelated) cy.getElementById(id).addClass('search-related');

			let lit: cytoscape.CollectionReturnValue | null = null;
			if (this.path) {
				lit = cy.collection();
				for (const id of [...this.path.nodes, ...this.path.edges]) lit = lit.union(cy.getElementById(id));
				lit.addClass('on-path');
			} else if (selected.nonempty()) {
				lit = selected.closedNeighborhood();
			} else if (this.searchActive) {
				let hits = cy.collection();
				for (const id of [...this.searchMatches, ...this.searchRelated]) hits = hits.union(cy.getElementById(id));
				lit = hits.union(hits.edgesWith(hits));
			}

			if (lit) {
				lit.addClass('highlighted');
				cy.elements().difference(lit).addClass('faded');
			}
			selected.addClass('selected');
		});
	}

	private renderInspector(): void {
		const cy = this.cy;
		if (!this.inspector) return;
		const node = cy && this.selectedNodeId ? cy.getElementById(this.selectedNodeId) : null;
		if (!cy || !node || node.empty()) {
			this.inspector.show(null);
			return;
		}

		const data = nodeData(node);
		const relations: InspectorRelation[] = node.connectedEdges().map(edge => {
			const { relationship, detail } = edgeData(edge);
			const out = edge.source().id() === node.id();
			return {
				verb: relationship,
				direction: out ? 'out' : 'in',
				other: this.rowFor(out ? edge.target() : edge.source()),
				detail,
			};
		});

		let path: PathStep[] | null = null;
		if (this.path) {
			path = this.path.nodes.map((id, i) => {
				const step: PathStep = { node: this.rowFor(cy.getElementById(id)) };
				if (i > 0) {
					const edge = cy.getElementById(this.path!.edges[i - 1]);
					step.via = {
						verb: edgeData(edge).relationship,
						direction: edge.source().id() === this.path!.nodes[i - 1] ? 'out' : 'in',
					};
				}
				return step;
			});
		}

		this.inspector.show({
			node: this.rowFor(node),
			description: data.description,
			degree: data.degree,
			relations,
			sourceNotes: data.sourceNotes ?? [],
			trail: this.trail
				.map(id => cy.getElementById(id))
				.filter(n => n.nonempty())
				.map(n => this.rowFor(n)),
			focusHops: this.focusHops,
			pickingPath: this.pickingPath,
			path,
		});
	}

	/**
	 * Shortest path, over what is visible, from the selection to `goalId`.
	 * Undirected: "A uses B" connects A and B whichever way it reads.
	 */
	private showPathTo(goalId: string): void {
		const cy = this.cy;
		if (!cy || !this.selectedNodeId) return;
		const visible = cy.elements(':visible');
		const result = visible.aStar({
			root: cy.getElementById(this.selectedNodeId),
			goal: cy.getElementById(goalId),
			directed: false,
		});
		this.pickingPath = false;
		if (result.found) {
			this.path = {
				nodes: result.path.nodes().map(n => n.id()),
				edges: result.path.edges().map(e => e.id()),
			};
		} else {
			this.path = { nodes: [this.selectedNodeId], edges: [] };
		}
		this.applyEmphasis();
		this.renderInspector();
		if (result.found) {
			this.frame(result.path, 60);
		}
	}

	private search(query: string): void {
		const generation = ++this.searchGeneration;
		const trimmed = query.trim();
		if (!trimmed) {
			this.clearSearch();
			return;
		}

		// Names first, instantly; the engine's ranked results replace them
		// once the debounce settles
		const matches = this.nameMatches(trimmed);
		this.setSearchResults({ matches, related: [], status: 'Searching notes and connections…' });
		this.scheduleEngineSearch(trimmed, generation);
	}

	/** Rendered nodes whose name contains the query, best match first. */
	private nameMatches(query: string): NodeRow[] {
		const cy = this.cy;
		if (!cy) return [];
		const key = normalizeKey(query);
		const scored: { node: cytoscape.NodeSingular; rank: number; degree: number }[] = [];
		cy.nodes().forEach(node => {
			const data = nodeData(node);
			const at = data.searchKey.indexOf(key);
			if (at < 0) return;
			// A single character matches half the graph anywhere in a name;
			// only count it at the start
			if (key.length < 2 && at > 0) return;
			const rank = data.searchKey === key ? 3 : at === 0 ? 2 : data.searchKey[at - 1] === ' ' ? 1 : 0;
			scored.push({ node, rank, degree: data.degree });
		});
		scored.sort((a, b) => b.rank - a.rank || b.degree - a.degree);
		return scored.map(({ node }) => this.rowFor(node));
	}

	private async engineSearch(query: string, generation: number): Promise<void> {
		const response = await this.plugin.queryEngine.search(query, {
			limit: SEARCH_LIMIT,
			snippets: false,
			reached: REACHED_LIMIT,
		});
		if (generation !== this.searchGeneration || !this.cy) return;

		const matches = this.nameMatches(query);
		const related: NodeRow[] = [];
		// One listing per node, under the first group that claims it
		const key = (row: NodeRow) => row.id ?? row.notePath ?? row.name;
		const seen = new Set(matches.map(key));
		const add = (list: NodeRow[], row: NodeRow) => {
			if (seen.has(key(row))) return;
			seen.add(key(row));
			list.push(row);
		};

		for (const hit of response.entities) {
			add(hit.match === 'graph' ? related : matches, this.entityRow(hit));
		}
		for (const hit of response.notes) {
			add(hit.matchedWords.length > 0 ? matches : related, this.noteRow(hit));
		}
		// Entities and notes are scored on separate scales; interleave by
		// score within each so neither kind fills the list on its own
		const reached = [
			...(response.reached?.entities ?? []).map(hit => ({ score: hit.score, row: this.entityRow(hit) })),
			...(response.reached?.notes ?? []).map(hit => ({ score: hit.score, row: this.noteRow(hit) })),
		].sort((a, b) => b.score - a.score);
		for (const { row } of reached) add(related, row);

		const matchIds = new Set(matches.map(row => row.id).filter((id): id is string => id !== null));
		for (const row of related) {
			if (row.id && !row.reason) row.reason = this.linkReason(row.id, matchIds);
		}

		this.setSearchResults({
			matches,
			related,
			status: response.indexing && response.indexing.total > 0
				? `Still indexing notes (${response.indexing.indexed}/${response.indexing.total}); results may be incomplete.`
				: undefined,
		});
	}

	private entityRow(hit: EntityHit): NodeRow {
		const node = this.cy?.getElementById(hit.id);
		const reasons: Record<EntityHit['match'], string | undefined> = {
			name: undefined,
			alias: 'Alias',
			description: 'Description',
			graph: undefined,
		};
		if (node && node.nonempty()) return this.rowFor(node, reasons[hit.match]);
		return {
			id: null,
			name: hit.name,
			type: hit.type,
			color: getEntityTypeColor(hit.type),
			reason: reasons[hit.match],
		};
	}

	private noteRow(hit: NoteHit): NodeRow {
		const reason = describeWhy(hit) || undefined;
		const id = this.noteNodeByPath.get(hit.path);
		const node = id ? this.cy?.getElementById(id) : undefined;
		if (node && node.nonempty()) return this.rowFor(node, reason);
		return {
			id: null,
			name: hit.title,
			type: 'NOTE',
			color: getEntityTypeColor('NOTE'),
			reason,
			notePath: hit.path,
		};
	}

	/**
	 * Why the graph walk reached a node: the edge tying it to a direct match,
	 * when there is one, read in its own direction.
	 */
	private linkReason(id: string, matchIds: Set<string>): string | undefined {
		const node = this.cy?.getElementById(id);
		if (!node || node.empty()) return undefined;
		const edge = node.connectedEdges().filter(e =>
			matchIds.has(e.source().id()) || matchIds.has(e.target().id())
		)[0];
		if (!edge) return 'Connected within a few steps';
		const { relationship } = edgeData(edge);
		const source = nodeData(edge.source()).name;
		const target = nodeData(edge.target()).name;
		return `${source} —${relationship}→ ${target}`;
	}

	/** Rank the vault by its connection to one node, and show that in the graph. */
	private async searchAround(id: string): Promise<void> {
		const node = this.cy?.getElementById(id);
		if (!node || node.empty()) return;
		const data = nodeData(node);
		const seed = isNoteNode(data) ? data.sourceNotes[0] : id;
		if (!seed) return;

		const generation = ++this.searchGeneration;
		this.searchBar?.setQuery('');
		const heading = `Around: ${data.name}`;
		this.setSearchResults({ heading, matches: [], related: [], status: 'Searching…' });

		const response = await this.plugin.queryEngine.search('', { limit: SEARCH_LIMIT, snippets: false, seed });
		if (generation !== this.searchGeneration || !this.cy) return;

		// Direct neighbours say which edge ties them to the seed; anything
		// further out was reached by the walk through intermediate nodes
		const neighbours = new Set(node.neighborhood('node').map(n => n.id()));
		const explain = (row: NodeRow): NodeRow => {
			row.reason = row.id && neighbours.has(row.id)
				? this.linkReason(row.id, new Set([id]))
				: 'Connected within a few steps';
			return row;
		};
		const related: NodeRow[] = [];
		for (const hit of response.entities) {
			if (hit.id !== id) related.push(explain(this.entityRow(hit)));
		}
		for (const hit of response.notes) {
			const row = this.noteRow(hit);
			if (row.id !== id) related.push(explain(row));
		}
		this.setSearchResults({ heading, matches: [this.rowFor(node)], related });
	}

	private showCluster(index: number): void {
		const cy = this.cy;
		const cluster = this.clusters.clusters[index];
		if (!cy || !cluster) return;
		++this.searchGeneration;
		this.searchBar?.setQuery('');
		const rows = cluster.members
			.map(id => cy.getElementById(id))
			.filter(node => node.nonempty())
			.sort((a, b) => nodeData(b).degree - nodeData(a).degree)
			.map(node => this.rowFor(node));
		this.deselect();
		this.setSearchResults({
			heading: `Cluster: ${this.clusterName(cluster.members)}`,
			matches: rows,
			related: [],
		});
		this.fitToFocus();
	}

	private setSearchResults(results: SearchResults): void {
		const ids = (rows: NodeRow[]) => new Set(rows.map(row => row.id).filter((id): id is string => id !== null));
		this.searchMatches = ids(results.matches);
		this.searchRelated = ids(results.related);
		this.searchActive = true;
		this.searchBar?.show(results);
		this.applyEmphasis();
	}

	private clearSearch(): void {
		++this.searchGeneration;
		this.searchMatches = new Set();
		this.searchRelated = new Set();
		this.searchActive = false;
		this.searchBar?.show(null);
		this.applyEmphasis();
	}

	/** Nothing to explore: the graph is empty. */
	private resetExploration(): void {
		this.selectedNodeId = null;
		this.trail = [];
		this.focusHops = 0;
		this.pickingPath = false;
		this.path = null;
		this.searchMatches = new Set();
		this.searchRelated = new Set();
		this.searchActive = false;
		this.searchBar?.show(null);
		this.inspector?.show(null);
	}

	/**
	 * After a re-render, keep what the user was exploring where the new graph
	 * still has it: the selection and trail by id, a typed query by running
	 * it again. A cluster or "around" list is dropped, since the clusters and
	 * ranks it came from were computed on the old graph.
	 */
	private restoreExploration(): void {
		const cy = this.cy;
		if (!cy) return;
		const exists = (id: string) => cy.getElementById(id).nonempty();
		if (this.selectedNodeId && !exists(this.selectedNodeId)) {
			this.selectedNodeId = null;
			this.focusHops = 0;
		}
		this.trail = this.selectedNodeId ? this.trail.filter(exists) : [];
		this.pickingPath = false;
		this.path = null;

		const query = this.searchBar?.query.trim() ?? '';
		if (query) {
			this.search(query);
		} else {
			this.clearSearch();
		}
		this.applyEmphasis();
		this.renderInspector();
	}

	private async openNote(path: string): Promise<void> {
		// From a main-area tab, opening in place would replace the graph itself
		const inMainArea = this.leaf.getRoot() === this.app.workspace.rootSplit;
		await this.app.workspace.openLinkText(path, '', inMainArea ? 'tab' : false);
	}

	onClose(): Promise<void> {
		this.stopLive();
		++this.renderToken;
		++this.layoutToken;
		++this.searchGeneration;
		if (this.styleFrame !== null) window.cancelAnimationFrame(this.styleFrame);
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
		return Promise.resolve();
	}
}
