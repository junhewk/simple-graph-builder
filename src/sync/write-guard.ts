/**
 * Keeping the plugin from reacting to its own writes.
 *
 * Auto-analysis is driven by `vault.on('modify')`. Write-back edits notes, so
 * without a guard every `related:` property the plugin writes would schedule an
 * analysis of the note it just wrote -- a paid API call per note, in a loop the
 * user never asked for.
 *
 * This is the first of three defenses, and the only one that is timing-based.
 * The others are structural: entity notes are excluded from analysis by path,
 * and note hashes cover the body only, so a write that slips through still
 * stops at the unchanged check without calling a model.
 */
import { normalizeKey } from '../types';

/**
 * How long a path stays claimed after a write finishes.
 *
 * Obsidian fires `modify` after the write promise resolves, and auto-analysis
 * debounces for 2s on top of that. Three seconds covers the gap; the cost of
 * being too generous is only that a user edit landing in the same window is
 * picked up by the next save instead.
 */
const GUARD_TTL_MS = 3000;

export class WriteGuard {
	private writes = new Map<string, number>();

	/** Run a vault write with its path claimed for the duration and shortly after. */
	async guard<T>(path: string, write: () => Promise<T>): Promise<T> {
		const key = normalizeKey(path);
		this.writes.set(key, Date.now() + GUARD_TTL_MS);
		try {
			return await write();
		} finally {
			// Refreshed rather than cleared: the modify event has not fired yet.
			this.writes.set(key, Date.now() + GUARD_TTL_MS);
		}
	}

	/** True when this path was written by the plugin a moment ago. */
	isOwnWrite(path: string): boolean {
		const key = normalizeKey(path);
		const expiry = this.writes.get(key);
		if (expiry === undefined) return false;
		if (Date.now() > expiry) {
			this.writes.delete(key);
			return false;
		}
		return true;
	}

	/** Drop expired claims. Called opportunistically; the map is small. */
	sweep(): void {
		const now = Date.now();
		for (const [key, expiry] of this.writes) {
			if (now > expiry) this.writes.delete(key);
		}
	}
}
