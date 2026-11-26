import { HashData, NoteHash, PluginData, normalizeUnicode } from '../types';
import { stripFrontmatter } from '../sync/note-content';
import { DataHost, readData, updateData } from '../data-store';

/**
 * The key a hash record is stored and matched under: the path in NFC.
 *
 * macOS can hand Obsidian NFD file names, and data.json syncs between devices
 * whose file systems disagree. A record stored in one form and looked up in the
 * other would make an analyzed note look new -- and re-analyzing it costs an
 * API call. Every lookup, filter and rename below compares through this.
 */
export function notePathKey(path: string): string {
	return normalizeUnicode(path);
}

/** A snapshot of the hash records, healed, for reading. Changes go through updateHashes. */
export async function loadHashes(host: DataHost): Promise<HashData> {
	const data = await readData(host);
	const hashes = data?.hashes?.hashes ? data.hashes : { hashes: [] };
	normalizeHashData(hashes);
	return hashes;
}

/**
 * Change the stored hash records through the data.json queue.
 *
 * `mutate` sees the records as they are on disk now, healed, and returns
 * false when it changed nothing. Resolves to what `mutate` reported: whether
 * the records changed. The save also happens when healing alone changed them.
 */
export async function updateHashes(host: DataHost, mutate: (hashes: HashData) => boolean | void): Promise<boolean> {
	let changed = false;
	await updateData(host, data => {
		const healed = healStoredHashes(data);
		changed = mutate(data.hashes) !== false;
		return changed || healed;
	});
	return changed;
}

/** Record a note's body hash after analyzing it. */
export function recordNoteHash(host: DataHost, path: string, hash: string): Promise<boolean> {
	return updateHashes(host, hashes => {
		updateNoteHash(hashes, path, hash);
	});
}

/**
 * Normalize stored paths and fold records that become duplicates, at load.
 * Resolves to true when data.json was rewritten.
 */
export function healHashRecords(host: DataHost): Promise<boolean> {
	return updateData(host, healStoredHashes);
}

function healStoredHashes(data: PluginData): boolean {
	if (!data.hashes?.hashes) data.hashes = { hashes: [] };
	return normalizeHashData(data.hashes);
}

/**
 * Store every record under its NFC path, keeping one record per path.
 *
 * Records that collide after normalization are the same note written from two
 * devices or two Obsidian versions; the most recent analysis wins. Returns
 * true when anything changed.
 */
export function normalizeHashData(hashes: HashData): boolean {
	const kept = new Map<string, NoteHash>();
	let changed = false;
	for (const record of hashes.hashes) {
		const path = notePathKey(record.path);
		const normalized = path === record.path ? record : { ...record, path };
		if (normalized !== record) changed = true;
		const existing = kept.get(path);
		if (!existing) {
			kept.set(path, normalized);
			continue;
		}
		changed = true;
		if ((normalized.analyzedAt ?? 0) > (existing.analyzedAt ?? 0)) kept.set(path, normalized);
	}
	if (changed) hashes.hashes = [...kept.values()];
	return changed;
}

function findRecord(hashes: HashData, path: string): NoteHash | undefined {
	const key = notePathKey(path);
	return hashes.hashes.find(h => notePathKey(h.path) === key);
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
	const existing = findRecord(hashes, path);
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
	const existing = findRecord(hashes, path);
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
	const existing = findRecord(hashes, path);
	if (!existing || existing.hash !== current.legacy || existing.hash === current.body) return false;

	existing.hash = current.body;
	return true;
}

/**
 * Get the hash record for a specific note.
 */
export function getNoteHash(hashes: HashData, path: string): NoteHash | undefined {
	return findRecord(hashes, path);
}

/**
 * Update or add a note's hash record, under the NFC path.
 */
export function updateNoteHash(hashes: HashData, path: string, hash: string): HashData {
	const key = notePathKey(path);
	const record: NoteHash = { path: key, hash, analyzedAt: Date.now() };
	const existingIndex = hashes.hashes.findIndex(h => notePathKey(h.path) === key);

	if (existingIndex >= 0) {
		hashes.hashes[existingIndex] = record;
	} else {
		hashes.hashes.push(record);
	}

	return hashes;
}

/**
 * Remove a note's hash record (when note is deleted or removed from graph).
 * Returns true when there was one.
 */
export function removeNoteHash(hashes: HashData, path: string): boolean {
	const key = notePathKey(path);
	const before = hashes.hashes.length;
	hashes.hashes = hashes.hashes.filter(h => notePathKey(h.path) !== key);
	return hashes.hashes.length !== before;
}

/**
 * Move a note's hash record to its new path. Returns true when one moved.
 *
 * A record already stored under the new path belonged to a note that is gone
 * -- deleting a note leaves its record behind -- and the moved one replaces it.
 */
export function renameNoteHash(hashes: HashData, oldPath: string, newPath: string): boolean {
	const from = notePathKey(oldPath);
	const to = notePathKey(newPath);
	const existing = hashes.hashes.find(h => notePathKey(h.path) === from);
	if (!existing) return false;
	if (from === to) {
		if (existing.path === to) return false;
		existing.path = to;
		return true;
	}
	hashes.hashes = hashes.hashes.filter(h => h === existing || notePathKey(h.path) !== to);
	existing.path = to;
	return true;
}

/**
 * Moves hash records after renames, one data.json write per burst.
 *
 * Moving a folder fires one rename event per note. Written one at a time, a
 * move of a few hundred analyzed notes would load and save the whole data.json
 * a few hundred times. Renames wait here instead, and the next write applies
 * all of them in order, so a -> b followed by b -> c still ends at c.
 */
export class HashRenameQueue {
	private pending: Array<[string, string]> = [];
	private write: Promise<void> | null = null;

	constructor(private readonly host: DataHost) {}

	/** Resolves once this rename is saved, or was nothing to save. */
	follow(oldPath: string, newPath: string): Promise<void> {
		this.pending.push([oldPath, newPath]);
		if (this.write) return this.write;

		const write = updateHashes(this.host, hashes => {
			// Renames arriving from here on need the next write.
			this.write = null;
			let changed = false;
			for (const [from, to] of this.pending.splice(0)) {
				if (renameNoteHash(hashes, from, to)) changed = true;
			}
			return changed;
		}).then(() => undefined);
		this.write = write;
		// A load that failed leaves the renames pending for the next write.
		write.catch(() => {
			if (this.write === write) this.write = null;
		});
		return write;
	}
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
export async function clearHashes(host: DataHost): Promise<void> {
	await updateData(host, data => {
		data.hashes = { hashes: [] };
	});
}
