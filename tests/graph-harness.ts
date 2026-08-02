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
