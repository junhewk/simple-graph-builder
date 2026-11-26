/**
 * The one way in and out of data.json.
 *
 * Obsidian keeps a plugin's data in a single file, read and written whole
 * through loadData/saveData. Settings, the graph, the resolution cache and the
 * note hash records all live in it, and each writer used to load the file,
 * change its own part and save it back, with awaits in between. When two of
 * them overlapped, the later save put back what the earlier one had replaced.
 * Dragging several analyzed notes into a folder lost all but one of their hash
 * records that way, and a debounced graph flush could restore stale ones. A
 * lost record makes a note look unanalyzed, and the next vault analysis pays to
 * extract it again.
 *
 * Here every read and write waits its turn on one queue per plugin. A write
 * loads the file fresh, applies its mutator, and saves before the next job
 * starts, so each writer changes only its own keys of the current file.
 *
 * Mutators are synchronous on purpose. Nothing that awaits -- an LLM call, an
 * embedding request -- can hold the queue: read what you need, do the slow
 * work, then queue a mutator that records the result.
 */
import { GRAPH_SCHEMA_VERSION } from './types';
import type { PluginData, Settings } from './types';
import { DEFAULT_SETTINGS } from './settings';

/** What the queue needs from the plugin. Test doubles provide just this. */
export interface DataHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
	settings?: Settings;
}

/**
 * Changes data.json in place. Return false when nothing changed, to skip the
 * save; returning nothing saves.
 */
export type DataMutator = (data: PluginData) => boolean | void;

const queues = new WeakMap<DataHost, Promise<unknown>>();

function enqueue<T>(host: DataHost, job: () => Promise<T>): Promise<T> {
	const next = (queues.get(host) ?? Promise.resolve()).then(job, job);
	// A failed job rejects its own caller; the jobs behind it still run.
	queues.set(host, next.catch(() => undefined));
	return next;
}

/** Read data.json after every write queued before this call has landed. */
export function readData(host: DataHost): Promise<PluginData | null> {
	return enqueue(host, async () => ((await host.loadData()) as PluginData | null) ?? null);
}

/**
 * Apply `mutate` to a fresh load of data.json and save it, in turn with every
 * other read and write. Resolves to whether the file was saved.
 */
export function updateData(host: DataHost, mutate: DataMutator): Promise<boolean> {
	return enqueue(host, async () => {
		const data = ((await host.loadData()) as PluginData | null) ?? emptyData(host);
		if (mutate(data) === false) return false;
		await host.saveData(data);
		return true;
	});
}

/** The file a first write creates: the shape older versions expect to read. */
function emptyData(host: DataHost): PluginData {
	return {
		settings: host.settings ?? DEFAULT_SETTINGS,
		graph: { nodes: [], edges: [], version: GRAPH_SCHEMA_VERSION },
		hashes: { hashes: [] },
	};
}
