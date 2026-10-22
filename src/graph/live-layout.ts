/**
 * ForceAtlas2 running in a web worker while the graph is on screen.
 *
 * This is how Obsidian's own graph view stays responsive: its d3-force
 * simulation runs in a worker (sim.js in the app bundle) and the view draws
 * whatever positions it has reached, so the graph appears at once and
 * settles in front of the user instead of after a frozen wait. Here the
 * worker runs graphology's FA2 -- the same force model, settings and edge
 * weights refineLayout runs synchronously -- and the view copies positions
 * into cytoscape as often as it can afford to redraw.
 *
 * graphology ships a supervisor for this, but it runs one iteration per
 * round trip through the main thread. Behind a view that spends ~0.5s
 * redrawing 2000 moved nodes, that throttled the worker to ~3.5 iterations
 * a second: 85s to settle a layout that takes ~2s of actual work. This host
 * keeps graphology's worker code but runs it in time slices of its own, so
 * the worker's pace no longer depends on the main thread's.
 *
 * Free of obsidian and cytoscape imports. It needs `Worker`, so it is not
 * exercised by the node test suite; the positions it produces go through
 * the same spacing pass refineLayout's tests cover.
 */
import Graph from 'graphology';
import DEFAULT_FA2_SETTINGS from 'graphology-layout-forceatlas2/defaults.js';
import { graphToByteArrays } from 'graphology-layout-forceatlas2/helpers.js';
import fa2WorkerBody from 'graphology-layout-forceatlas2/webworker.js';
import { LayoutEdge, LayoutNode, separateCoincident } from './layout';

export interface LiveForces {
	/** FA2 repulsion scaling (Gephi's "Scaling"). */
	scalingRatio: number;
	/** Strong-mode pull toward the origin. */
	gravity: number;
}

export interface LiveLayoutOptions extends LiveForces {
	/** Iterations before the layout stops on its own. */
	maxIterations: number;
	/** Nodes that keep their position: already placed ones, while newcomers settle around them. */
	fixed?: ReadonlySet<string>;
}

/** Worker time per round trip; long enough that messaging is noise, short enough to stop promptly. */
const SLICE_MS = 30;

/** Values per node in FA2's matrix; x and y are the first two. */
const PPN = 10;

interface HostRequest {
	nodes: ArrayBuffer;
	edges?: ArrayBuffer;
	settings: Record<string, unknown>;
	iterations: number;
	sliceMs: number;
}

interface HostReply {
	nodes: ArrayBuffer;
	iterations: number;
}

/**
 * Runs inside the worker, so it must not touch anything outside its own body
 * (it is shipped as source text). graphology's worker body registers a
 * message handler that runs one iteration and posts the matrix back; this
 * captures that handler and its reply instead of letting them reach the
 * channel, then calls it in a loop for each request.
 *
 * The postMessage capture stays in place for the worker's life: the library
 * looks postMessage up each time it replies, not when it registers. Restoring
 * it after registration let every reply through to the main thread with a
 * detached buffer, and the view read NaN positions back.
 */
function fa2Host(libraryWorker: () => void): void {
	type Listener = (event: { data: unknown }) => void;
	interface Scope {
		addEventListener(type: string, listener: Listener): void;
		postMessage(message: unknown, transfer?: unknown[]): void;
	}
	const scope = self as unknown as Scope;
	const addEventListener = scope.addEventListener;
	const postMessage = scope.postMessage;
	let iterate: Listener | null = null;
	let result: ArrayBuffer | null = null;

	scope.addEventListener = (type, listener) => {
		if (type === 'message') iterate = listener;
	};
	scope.postMessage = message => {
		result = (message as { nodes: ArrayBuffer }).nodes;
	};
	libraryWorker();
	scope.addEventListener = addEventListener;

	scope.addEventListener('message', event => {
		const request = event.data as HostRequest;
		const step = iterate;
		if (!step) return;
		result = null;
		let nodes = request.nodes;
		// Edges go with the first iteration only; the library keeps them
		let edges = request.edges;
		let done = 0;
		const start = performance.now();
		while (done < request.iterations) {
			step({ data: { nodes, edges, settings: request.settings } });
			edges = undefined;
			if (!result) throw new Error('FA2 worker produced no positions');
			nodes = result;
			done++;
			if (performance.now() - start >= request.sliceMs) break;
		}
		const reply: HostReply = { nodes, iterations: done };
		postMessage.call(scope, reply, [nodes]);
	});
}

function createWorker(): Worker {
	const source = `(${fa2Host.toString()})(${(fa2WorkerBody as () => void).toString()});`;
	const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
	try {
		return new Worker(url);
	} finally {
		URL.revokeObjectURL(url);
	}
}

export class LiveLayout {
	private readonly ids: string[];
	private readonly worker: Worker;
	private readonly settings: Record<string, unknown>;
	/** Latest positions, x and y per node in `ids` order. */
	private readonly xy: Float32Array;
	private nodes: Float32Array | null;
	private edges: Float32Array | null;
	private iterations = 0;
	private budget: number;
	private running = false;
	private finished = false;
	private fresh = false;
	/** Set if the worker failed; the caller can then settle without it. */
	failed = false;

	constructor(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[], opts: LiveLayoutOptions) {
		// FA2 skips every force between nodes at exactly the same point, so a
		// spectral seed's stacks would never come apart
		const positions = nodes.map(n => ({ x: n.x, y: n.y }));
		separateCoincident(positions);

		const graph = new Graph({ multi: true, type: 'undirected' });
		nodes.forEach((n, i) => {
			graph.addNode(n.id, {
				x: positions[i].x,
				y: positions[i].y,
				size: n.radius,
				fixed: opts.fixed?.has(n.id) ?? false,
			});
		});
		for (const e of edges) {
			if (graph.hasNode(e.source) && graph.hasNode(e.target)) {
				graph.addEdge(e.source, e.target, { weight: e.weight ?? 1 });
			}
		}

		// Matrix order is graph.nodes() order
		this.ids = graph.nodes();
		const matrices = graphToByteArrays(graph, (_edge, attrs) => (attrs.weight as number | undefined) ?? 1);
		this.nodes = matrices.nodes;
		this.edges = matrices.edges;
		this.xy = new Float32Array(this.ids.length * 2);
		this.readPositions(matrices.nodes);

		this.budget = opts.maxIterations;
		this.settings = {
			...DEFAULT_FA2_SETTINGS,
			scalingRatio: opts.scalingRatio,
			gravity: opts.gravity,
			strongGravityMode: true,
			// Same choices as refineLayout: exact repulsion is O(n^2) per
			// iteration, and slowDown keeps big graphs from jittering
			barnesHutOptimize: nodes.length > 500,
			slowDown: 1 + Math.log(Math.max(nodes.length, 1)),
		};

		this.worker = createWorker();
		this.worker.addEventListener('message', (event: MessageEvent<HostReply>) => this.receive(event.data));
		this.worker.addEventListener('error', event => {
			console.error('[simple-graph-builder] layout worker failed', event.message);
			this.failed = true;
			this.finish();
		});
	}

	start(): void {
		if (this.running || this.finished) return;
		this.running = true;
		this.request();
	}

	/** Stop early; the positions reached so far stay readable. */
	stop(): void {
		this.finish();
	}

	kill(): void {
		this.finish();
		this.worker.terminate();
	}

	/** True once the budget is spent, the layout was stopped, or the worker failed. */
	get done(): boolean {
		return this.finished;
	}

	/** Whether positions arrived since the last call. */
	takeFresh(): boolean {
		const fresh = this.fresh;
		this.fresh = false;
		return fresh;
	}

	/**
	 * Change repulsion or gravity mid-run. The worker receives the settings
	 * with every slice, so this takes effect within ~30ms; the budget starts
	 * over so the new forces get a full run.
	 */
	setForces(forces: LiveForces): void {
		this.settings.scalingRatio = forces.scalingRatio;
		this.settings.gravity = forces.gravity;
		this.iterations = 0;
	}

	forEachPosition(callback: (id: string, x: number, y: number) => void): void {
		for (let i = 0; i < this.ids.length; i++) callback(this.ids[i], this.xy[2 * i], this.xy[2 * i + 1]);
	}

	private request(): void {
		const nodes = this.nodes;
		if (!nodes) return;
		const message: HostRequest = {
			nodes: nodes.buffer as ArrayBuffer,
			settings: this.settings,
			iterations: Math.max(1, this.budget - this.iterations),
			sliceMs: SLICE_MS,
		};
		const transfer: ArrayBuffer[] = [nodes.buffer as ArrayBuffer];
		if (this.edges) {
			message.edges = this.edges.buffer as ArrayBuffer;
			transfer.push(this.edges.buffer as ArrayBuffer);
			this.edges = null;
		}
		// The matrix belongs to the worker until it comes back
		this.nodes = null;
		this.worker.postMessage(message, transfer);
	}

	private receive(reply: HostReply): void {
		const nodes = new Float32Array(reply.nodes);
		this.nodes = nodes;
		if (this.finished) return;
		this.readPositions(nodes);
		this.fresh = true;
		this.iterations += reply.iterations;
		if (this.iterations >= this.budget) this.finish();
		else this.request();
	}

	private readPositions(matrix: Float32Array): void {
		for (let i = 0; i < this.ids.length; i++) {
			this.xy[2 * i] = matrix[i * PPN];
			this.xy[2 * i + 1] = matrix[i * PPN + 1];
		}
	}

	private finish(): void {
		this.running = false;
		this.finished = true;
	}
}
