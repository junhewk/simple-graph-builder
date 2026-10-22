// graphology-layout-forceatlas2 ships types for its public entry points only.
// live-layout.ts hosts the library's own worker body and matrix builder, so
// it needs these three internal modules typed too.

declare module 'graphology-layout-forceatlas2/defaults.js' {
	const DEFAULT_SETTINGS: Record<string, unknown>;
	export default DEFAULT_SETTINGS;
}

declare module 'graphology-layout-forceatlas2/helpers.js' {
	import type Graph from 'graphology';
	import type { Attributes } from 'graphology-types';
	export function graphToByteArrays(
		graph: Graph,
		getEdgeWeight: (edge: string, attributes: Attributes) => number,
	): { nodes: Float32Array; edges: Float32Array };
}

declare module 'graphology-layout-forceatlas2/webworker.js' {
	/** The worker body; shipped to a Worker as source text. */
	const worker: () => void;
	export default worker;
}
