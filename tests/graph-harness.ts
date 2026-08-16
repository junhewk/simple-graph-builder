/**
 * Shared setup for the suites that exercise GraphCache.
 *
 * Not a *.test.ts, so the runner won't try to execute it directly.
 *
 * GraphCache debounces persistence through window.setTimeout, which doesn't
 * exist under node. The shim below is a no-op scheduler: these suites assert on
 * in-memory state and never want a real save to fire.
 */
import type { GraphData } from '../src/types';

const g = globalThis as Record<string, unknown>;
if (!g.window) {
	g.window = {
		setTimeout: () => 0,
		clearTimeout: () => undefined,
	};
}

/** Minimal plugin surface: GraphCache only calls loadData/saveData. */
export function fakePlugin(graph?: Partial<GraphData>) {
	const saved: unknown[] = [];
	const plugin = {
		loadData: async () => (graph ? { graph } : null),
		saveData: async (data: unknown) => { saved.push(data); },
	};
	return { plugin: plugin as never, saved };
}

/**
 * Same, but backed by a whole data.json. Needed by suites that assert what
 * survives a load/save round trip -- resolution cache, embedding index, hashes
 * -- rather than just the graph.
 */
export function fakePluginWithData(data?: Record<string, unknown>) {
	const saved: Record<string, unknown>[] = [];
	let current = data ? JSON.parse(JSON.stringify(data)) : null;
	const plugin = {
		loadData: async () => (current ? JSON.parse(JSON.stringify(current)) : null),
		saveData: async (next: Record<string, unknown>) => {
			current = JSON.parse(JSON.stringify(next));
			saved.push(next);
		},
	};
	return { plugin: plugin as never, saved, latest: () => current };
}
