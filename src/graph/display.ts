/**
 * User-adjustable appearance and layout forces for the graph view.
 *
 * Every numeric value is a multiplier on the view's own computed default
 * (1 = unchanged) except where noted, so the size- and density-aware choices
 * in visual-metrics and layout stay in charge and the user only leans on
 * them. Persisted under settings.graphDisplay.
 *
 * Deliberately free of obsidian and cytoscape imports so tests can run it.
 */

export type GraphColorMode = 'type' | 'cluster';

export interface GraphDisplaySettings {
	// Nodes
	nodeSize: number;
	/** Absolute fill alpha, 0-1. */
	nodeOpacity: number;
	/** Absolute label font size in px. */
	labelSize: number;
	colorBy: GraphColorMode;
	/** Per-entity-type colour overrides; a missing type keeps its built-in colour. */
	typeColors: Record<string, string>;
	/** Entity types hidden from the view. */
	hiddenTypes: string[];
	// Edges
	edgeWidth: number;
	/** Multiplies each edge's connectivity-derived alpha, capped at 1. */
	edgeOpacity: number;
	/** Hex colour; blank follows the theme. */
	edgeColor: string;
	/** Draw each edge's relationship verb along it. */
	edgeLabels: boolean;
	// Forces
	repulsion: number;
	linkLength: number;
	gravity: number;
	/** Clearance kept around each node after the force pass. */
	spacing: number;
	// Clusters
	/** 0-1: how strongly the layout gathers each cluster together. */
	clusterPull: number;
	/** Louvain resolution: higher finds more, smaller clusters. */
	clusterResolution: number;
}

export const DEFAULT_GRAPH_DISPLAY: GraphDisplaySettings = {
	nodeSize: 1,
	nodeOpacity: 0.9,
	labelSize: 10,
	colorBy: 'type',
	typeColors: {},
	hiddenTypes: [],
	edgeWidth: 1,
	edgeOpacity: 1,
	edgeColor: '',
	edgeLabels: false,
	repulsion: 1,
	linkLength: 1,
	gravity: 1,
	spacing: 1,
	clusterPull: 0,
	clusterResolution: 1,
};

export type NumericDisplayKey = {
	[K in keyof GraphDisplaySettings]: GraphDisplaySettings[K] extends number ? K : never
}[keyof GraphDisplaySettings];

export const DISPLAY_RANGES: Record<NumericDisplayKey, { min: number; max: number; step: number }> = {
	nodeSize: { min: 0.3, max: 3, step: 0.1 },
	nodeOpacity: { min: 0.1, max: 1, step: 0.05 },
	labelSize: { min: 6, max: 24, step: 1 },
	edgeWidth: { min: 0.2, max: 5, step: 0.1 },
	edgeOpacity: { min: 0, max: 3, step: 0.1 },
	repulsion: { min: 0.2, max: 5, step: 0.1 },
	linkLength: { min: 0.3, max: 3, step: 0.1 },
	gravity: { min: 0, max: 5, step: 0.1 },
	spacing: { min: 0.5, max: 2.5, step: 0.1 },
	clusterPull: { min: 0, max: 1, step: 0.05 },
	clusterResolution: { min: 0.2, max: 3, step: 0.1 },
};

/** Keys whose change needs a new layout rather than a restyle. */
export const LAYOUT_KEYS: ReadonlySet<keyof GraphDisplaySettings> = new Set([
	'repulsion', 'linkLength', 'gravity', 'spacing', 'clusterPull',
]);

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * How much longer than the layout's own ideal an edge should settle, given
 * the link-length setting and whether cluster pull applies to it. Pull
 * shortens edges inside a cluster and lengthens the ones between clusters,
 * which is what draws each cluster into its own region.
 */
export function edgeLengthFactor(display: GraphDisplaySettings, sameCluster: boolean): number {
	const pull = display.clusterPull;
	const clusterFactor = pull === 0 ? 1 : sameCluster ? 1 - 0.6 * pull : 1 + pull;
	return display.linkLength * clusterFactor;
}

/**
 * Fill in defaults and clamp a stored value.
 *
 * Settings load with a shallow Object.assign, so a graphDisplay saved by an
 * older version comes back missing whatever keys were added since, and a
 * hand-edited data.json can hold anything. Everything the view reads goes
 * through here.
 */
export function normalizeGraphDisplay(raw: unknown): GraphDisplaySettings {
	const input = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof GraphDisplaySettings, unknown>>;
	const out: GraphDisplaySettings = { ...DEFAULT_GRAPH_DISPLAY, typeColors: {}, hiddenTypes: [] };

	for (const key of Object.keys(DISPLAY_RANGES) as NumericDisplayKey[]) {
		const value = input[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			const { min, max } = DISPLAY_RANGES[key];
			out[key] = Math.min(max, Math.max(min, value));
		}
	}

	if (input.colorBy === 'type' || input.colorBy === 'cluster') out.colorBy = input.colorBy;
	if (typeof input.edgeLabels === 'boolean') out.edgeLabels = input.edgeLabels;
	if (typeof input.edgeColor === 'string' && HEX_COLOR.test(input.edgeColor)) out.edgeColor = input.edgeColor;

	if (input.typeColors && typeof input.typeColors === 'object') {
		for (const [type, color] of Object.entries(input.typeColors as Record<string, unknown>)) {
			if (typeof color === 'string' && HEX_COLOR.test(color)) out.typeColors[type] = color;
		}
	}
	if (Array.isArray(input.hiddenTypes)) {
		out.hiddenTypes = [...new Set(input.hiddenTypes.filter((t): t is string => typeof t === 'string'))];
	}

	return out;
}

/**
 * A colour as #rrggbb, which is all a colour input accepts. Entity types the
 * built-in palette doesn't know get an hsl() colour from getEntityTypeColor.
 * Anything unparseable comes back as the neutral grey.
 */
export function colorToHex(color: string): string {
	if (HEX_COLOR.test(color)) return color.toLowerCase();
	const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(color);
	if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
	const hsl = /^hsl\(\s*(-?[\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(color);
	if (!hsl) return '#94a3b8';
	const h = ((Number(hsl[1]) % 360) + 360) % 360;
	const s = Number(hsl[2]) / 100;
	const l = Number(hsl[3]) / 100;
	const a = s * Math.min(l, 1 - l);
	const channel = (n: number) => {
		const k = (n + h / 30) % 12;
		const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
		return Math.round(v * 255).toString(16).padStart(2, '0');
	};
	return `#${channel(0)}${channel(8)}${channel(4)}`;
}
