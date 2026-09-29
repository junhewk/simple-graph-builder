/**
 * Personalized PageRank over a weighted undirected graph in CSR form.
 *
 * Seeded from what the query matched, the walk spreads relevance along
 * relations, mentions and wikilinks, so a note that never uses the query's
 * words but is about a matched entity still ranks, and ranks below the
 * notes that match directly. This is the HippoRAG retrieval step, run over
 * the plugin's own graph.
 */

export interface Csr {
	/** offsets[i]..offsets[i+1] index into targets/weights for node i. */
	offsets: Int32Array;
	targets: Int32Array;
	weights: Float32Array;
	/** Sum of edge weights per node. */
	strength: Float64Array;
}

export function buildCsr(nodeCount: number, edges: readonly [number, number, number][]): Csr {
	const degree = new Int32Array(nodeCount);
	for (const [a, b] of edges) {
		degree[a]++;
		degree[b]++;
	}
	const offsets = new Int32Array(nodeCount + 1);
	for (let i = 0; i < nodeCount; i++) offsets[i + 1] = offsets[i] + degree[i];
	const targets = new Int32Array(offsets[nodeCount]);
	const weights = new Float32Array(offsets[nodeCount]);
	const strength = new Float64Array(nodeCount);
	const cursor = offsets.slice(0, nodeCount);
	for (const [a, b, w] of edges) {
		targets[cursor[a]] = b;
		weights[cursor[a]++] = w;
		targets[cursor[b]] = a;
		weights[cursor[b]++] = w;
		strength[a] += w;
		strength[b] += w;
	}
	return { offsets, targets, weights, strength };
}

export interface PprOptions {
	/** Probability of jumping back to a seed at each step. */
	restart?: number;
	iterations?: number;
}

/**
 * Power iteration. Mass on a node with no edges returns to the seeds, so the
 * scores stay a probability distribution.
 */
export function personalizedPageRank(csr: Csr, seeds: ReadonlyMap<number, number>, options: PprOptions = {}): Float64Array {
	const n = csr.strength.length;
	const restart = options.restart ?? 0.5;
	const iterations = options.iterations ?? 25;

	const p = new Float64Array(n);
	let total = 0;
	for (const [node, weight] of seeds) {
		if (node < 0 || node >= n || !(weight > 0)) continue;
		p[node] += weight;
		total += weight;
	}
	if (total === 0) return new Float64Array(n);
	for (let i = 0; i < n; i++) p[i] /= total;

	let rank = Float64Array.from(p);
	let next = new Float64Array(n);
	for (let iter = 0; iter < iterations; iter++) {
		next.fill(0);
		let dangling = 0;
		for (let i = 0; i < n; i++) {
			const mass = rank[i];
			if (mass === 0) continue;
			const s = csr.strength[i];
			if (s === 0) {
				dangling += mass;
				continue;
			}
			const share = (1 - restart) * mass / s;
			for (let e = csr.offsets[i]; e < csr.offsets[i + 1]; e++) {
				next[csr.targets[e]] += share * csr.weights[e];
			}
		}
		const back = restart + (1 - restart) * dangling;
		for (let i = 0; i < n; i++) next[i] += back * p[i];
		[rank, next] = [next, rank];
	}
	return rank;
}

/** Plain PageRank: every node is a seed. Used for "most central" rankings. */
export function globalPageRank(csr: Csr, iterations = 30): Float64Array {
	const seeds = new Map<number, number>();
	for (let i = 0; i < csr.strength.length; i++) seeds.set(i, 1);
	return personalizedPageRank(csr, seeds, { restart: 0.15, iterations });
}
