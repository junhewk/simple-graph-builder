/**
 * Remembered node positions for the graph view.
 *
 * Without them every render -- including the refresh after each analysed note
 * -- laid the whole graph out again from a random start: seconds of waiting
 * on a large vault, and a map that rearranged itself every time, which is
 * the opposite of what a map is for. With them the view opens on the
 * positions it had, places only what is new, and lets the layout settle the
 * newcomers around a fixed frame.
 *
 * Deliberately free of obsidian and cytoscape imports: the store reads and
 * writes through an injected file, so the test suite can run it under node.
 */

export interface Point {
	x: number;
	y: number;
}

export type PositionMap = Map<string, Point>;

export interface PositionFile {
	read(): Promise<string | null>;
	write(text: string): Promise<void>;
}

/** Reuse remembered positions when at least this share of the nodes has one. */
export const REUSE_KNOWN_FRACTION = 0.5;

const FORMAT_VERSION = 1;

/** One decimal: sub-pixel precision at any zoom the view allows, a third the size. */
const round = (value: number): number => Math.round(value * 10) / 10;

export function serializePositions(positions: PositionMap): string {
	const out: Record<string, [number, number]> = {};
	for (const [id, p] of positions) out[id] = [round(p.x), round(p.y)];
	return JSON.stringify({ version: FORMAT_VERSION, positions: out });
}

/** Parse a saved file; anything malformed yields an empty map rather than an error. */
export function parsePositions(text: string | null): PositionMap {
	const positions: PositionMap = new Map();
	if (!text) return positions;
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return positions;
	}
	if (!data || typeof data !== 'object') return positions;
	const { version, positions: raw } = data as { version?: unknown; positions?: unknown };
	if (version !== FORMAT_VERSION || !raw || typeof raw !== 'object') return positions;
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!Array.isArray(value) || value.length !== 2) continue;
		const [x, y] = value as unknown[];
		if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
			positions.set(id, { x, y });
		}
	}
	return positions;
}

/**
 * Positions for nodes the map doesn't know yet, placed beside the known
 * nodes they connect to.
 *
 * A new node goes at the centroid of its placed neighbours, nudged off it on
 * a golden-angle spiral so siblings don't stack. Placement spreads outward
 * in waves, so a new node two steps from the known graph is placed after the
 * one between them. Whatever is left -- new components with no tie to the
 * map -- goes on a ring outside the known layout, where the force pass can
 * draw it in if it has to.
 */
export function placeNewNodes(
	ids: readonly string[],
	edges: readonly { source: string; target: string }[],
	known: PositionMap,
	spacing: number,
): PositionMap {
	const placed: PositionMap = new Map();
	const at = (id: string) => known.get(id) ?? placed.get(id);
	const pending = new Set(ids.filter(id => !known.has(id)));
	if (pending.size === 0) return placed;

	const neighbours = new Map<string, string[]>();
	const link = (a: string, b: string) => {
		const list = neighbours.get(a);
		if (list) list.push(b);
		else neighbours.set(a, [b]);
	};
	for (const e of edges) {
		if (e.source === e.target) continue;
		link(e.source, e.target);
		link(e.target, e.source);
	}

	const GOLDEN_ANGLE = 2.399963229728653;
	let nudge = 0;
	while (pending.size > 0) {
		const wave: [string, Point][] = [];
		for (const id of pending) {
			let sx = 0, sy = 0, count = 0;
			for (const other of neighbours.get(id) ?? []) {
				const p = at(other);
				if (!p) continue;
				sx += p.x;
				sy += p.y;
				count++;
			}
			if (count === 0) continue;
			nudge++;
			const r = spacing * (0.6 + 0.15 * Math.sqrt(nudge % 40));
			wave.push([id, {
				x: sx / count + r * Math.cos(nudge * GOLDEN_ANGLE),
				y: sy / count + r * Math.sin(nudge * GOLDEN_ANGLE),
			}]);
		}
		// Placed a wave at a time, so a node's position never depends on the
		// iteration order within its own wave
		for (const [id, p] of wave) {
			placed.set(id, p);
			pending.delete(id);
		}
		if (wave.length === 0) break;
	}

	if (pending.size > 0) {
		let cx = 0, cy = 0, n = 0, radius = 0;
		const all = [...known.values(), ...placed.values()];
		for (const p of all) {
			cx += p.x;
			cy += p.y;
			n++;
		}
		if (n > 0) {
			cx /= n;
			cy /= n;
			for (const p of all) radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy));
		}
		const ring = radius + 2 * spacing;
		const rest = [...pending];
		rest.forEach((id, i) => {
			const angle = (i / rest.length) * 2 * Math.PI;
			placed.set(id, { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle) });
		});
	}

	return placed;
}

/**
 * The remembered positions, loaded once and written back on demand.
 *
 * Positions of nodes that are only filtered out stay in the file, so turning
 * a filter back on finds them where they were. Nodes gone from the graph
 * itself are pruned on save.
 */
export class PositionStore {
	private positions: PositionMap = new Map();
	private loaded: Promise<void> | null = null;

	constructor(private readonly file: PositionFile) {}

	load(): Promise<void> {
		this.loaded ??= this.file.read()
			.then(text => { this.positions = parsePositions(text); })
			.catch(() => { this.positions = new Map(); });
		return this.loaded;
	}

	get(id: string): Point | undefined {
		return this.positions.get(id);
	}

	get size(): number {
		return this.positions.size;
	}

	update(points: Iterable<[string, Point]>): void {
		for (const [id, p] of points) this.positions.set(id, { x: p.x, y: p.y });
	}

	async save(existing: ReadonlySet<string>): Promise<void> {
		for (const id of this.positions.keys()) {
			if (!existing.has(id)) this.positions.delete(id);
		}
		await this.file.write(serializePositions(this.positions));
	}
}
