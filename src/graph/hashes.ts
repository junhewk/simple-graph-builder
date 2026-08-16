import { HashData, NoteHash, PluginData } from '../types';
import { stripFrontmatter } from '../sync/note-content';
import SimpleGraphBuilderPlugin from '../main';

export async function loadHashes(plugin: SimpleGraphBuilderPlugin): Promise<HashData> {
	const data = (await plugin.loadData()) as PluginData | null;
	return data?.hashes ?? { hashes: [] };
}

export async function saveHashes(plugin: SimpleGraphBuilderPlugin, hashes: HashData): Promise<void> {
	const data = ((await plugin.loadData()) as PluginData | null) ?? {
		settings: plugin.settings,
		graph: { nodes: [], edges: [], version: 1 },
		hashes: { hashes: [] },
	};

	data.hashes = hashes;
	await plugin.saveData(data);
}

/**
 * Compute a hash of the content using cyrb53 algorithm.
 * More robust than simple djb2 hash with better distribution.
 */
export function computeHash(content: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;

	for (let i = 0; i < content.length; i++) {
		const ch = content.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}

	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);

	// Return 53-bit hash as hex string
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * Check if a note has changed since last analysis.
 */
export function hasNoteChanged(hashes: HashData, path: string, currentHash: string): boolean {
	const existing = hashes.hashes.find(h => h.path === path);
	return !existing || existing.hash !== currentHash;
}

/**
 * The two hashes a note can be recognized by.
 *
 * `body` is what gets stored. It ignores frontmatter, because the plugin itself
 * writes a `related:` property there -- hashing the whole file would mark every
 * note the plugin touched as changed and re-analyze it, at cost, on the next
 * save. It also means a user editing tags no longer pays for a re-analysis.
 *
 * `legacy` is the whole-file hash this plugin stored before that change. Notes
 * analyzed by an earlier version carry it, and accepting it as a match is what
 * keeps an upgrade from re-analyzing an entire vault. Stored hashes convert to
 * the body form one note at a time, as notes are actually re-analyzed.
 */
export interface NoteHashes {
	body: string;
	legacy: string;
}

export function computeNoteHashes(content: string): NoteHashes {
	return { body: computeHash(stripFrontmatter(content).body), legacy: computeHash(content) };
}

/** True when neither the stored body hash nor a pre-upgrade full hash matches. */
export function hasNoteChangedByHashes(hashes: HashData, path: string, current: NoteHashes): boolean {
	const existing = hashes.hashes.find(h => h.path === path);
	if (!existing) return true;
	return existing.hash !== current.body && existing.hash !== current.legacy;
}

/**
 * Convert a note's stored whole-file hash to a body hash, in place.
 *
 * Without this the legacy form survives until the note is next analyzed, and
 * the first thing that edits its frontmatter -- write-back, or the user adding
 * a tag -- invalidates it. Turning on write-back would then re-analyze, and
 * re-bill, every note in the vault that had not changed since the upgrade.
 * Recognizing a note by its legacy hash is exactly the moment we know the body
 * hash is equivalent, so it costs nothing to record it.
 *
 * Returns true when a record was rewritten and the caller should save.
 */
export function upgradeLegacyHash(hashes: HashData, path: string, current: NoteHashes): boolean {
	const existing = hashes.hashes.find(h => h.path === path);
	if (!existing || existing.hash !== current.legacy || existing.hash === current.body) return false;

	existing.hash = current.body;
	return true;
}

/**
 * Get the hash record for a specific note.
 */
export function getNoteHash(hashes: HashData, path: string): NoteHash | undefined {
	return hashes.hashes.find(h => h.path === path);
}

/**
 * Update or add a note's hash record.
 */
export function updateNoteHash(hashes: HashData, path: string, hash: string): HashData {
	const now = Date.now();
	const existingIndex = hashes.hashes.findIndex(h => h.path === path);

	if (existingIndex >= 0) {
		hashes.hashes[existingIndex] = {
			path,
			hash,
			analyzedAt: now,
		};
	} else {
		hashes.hashes.push({
			path,
			hash,
			analyzedAt: now,
		});
	}

	return hashes;
}

/**
 * Remove a note's hash record (when note is deleted or removed from graph).
 */
export function removeNoteHash(hashes: HashData, path: string): HashData {
	hashes.hashes = hashes.hashes.filter(h => h.path !== path);
	return hashes;
}

/**
 * Update hash when a note is renamed.
 */
export function renameNoteHash(hashes: HashData, oldPath: string, newPath: string): HashData {
	const existing = hashes.hashes.find(h => h.path === oldPath);
	if (existing) {
		existing.path = newPath;
	}
	return hashes;
}

/**
 * Get all analyzed note paths.
 */
export function getAnalyzedNotePaths(hashes: HashData): string[] {
	return hashes.hashes.map(h => h.path);
}

/**
 * Get statistics about analyzed notes.
 */
export function getHashStats(hashes: HashData): { count: number; oldestAnalysis: number | null; newestAnalysis: number | null } {
	if (hashes.hashes.length === 0) {
		return { count: 0, oldestAnalysis: null, newestAnalysis: null };
	}

	const timestamps = hashes.hashes.map(h => h.analyzedAt).filter(t => t != null);
	return {
		count: hashes.hashes.length,
		oldestAnalysis: timestamps.length > 0 ? Math.min(...timestamps) : null,
		newestAnalysis: timestamps.length > 0 ? Math.max(...timestamps) : null,
	};
}

/**
 * Clear all hash records.
 */
export async function clearHashes(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	await saveHashes(plugin, { hashes: [] });
}
