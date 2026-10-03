/**
 * Which vault files belong to which import.
 *
 * Imported pages are med-lit's output, already turned into graph data from
 * med-lit's own database. Analyzing them again would pay an LLM to re-derive a
 * worse copy of what is already there, and writing `related:` into them would
 * make every one look locally edited at the next update. So the rest of the
 * plugin asks this registry before touching a note.
 */
import { normalizeKey } from '../types';
import type { ImportManifest } from './types';

export class ImportRegistry {
	private manifests = new Map<string, ImportManifest>();
	private owner = new Map<string, string>();
	/** Paths an import in progress is about to write, before its manifest exists. */
	private pending = new Map<string, string>();

	constructor(initial?: Record<string, ImportManifest> | null) {
		for (const manifest of Object.values(initial ?? {})) this.manifests.set(manifest.projectId, manifest);
		this.reindex();
	}

	private reindex(): void {
		this.owner.clear();
		for (const manifest of this.manifests.values()) {
			for (const file of Object.values(manifest.files)) this.owner.set(normalizeKey(file.path), manifest.projectId);
		}
	}

	all(): ImportManifest[] {
		return [...this.manifests.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	get(projectId: string): ImportManifest | undefined {
		return this.manifests.get(projectId);
	}

	/** The project id that owns this path, if any. */
	ownerOf(path: string): string | undefined {
		const key = normalizeKey(path);
		return this.owner.get(key) ?? this.pending.get(key);
	}

	isImported(path: string): boolean {
		return this.ownerOf(path) !== undefined;
	}

	upsert(manifest: ImportManifest): void {
		this.manifests.set(manifest.projectId, manifest);
		this.reindex();
	}

	remove(projectId: string): void {
		this.manifests.delete(projectId);
		this.reindex();
	}

	/** Claim paths an import is about to write, so exclusion applies mid-run. */
	claim(projectId: string, paths: Iterable<string>): void {
		for (const path of paths) this.pending.set(normalizeKey(path), projectId);
	}

	releaseClaims(projectId: string): void {
		for (const [path, owner] of [...this.pending]) if (owner === projectId) this.pending.delete(path);
	}

	/**
	 * Follow a rename made in Obsidian. Returns true when a manifest changed and
	 * needs saving. A folder rename arrives as one call per file.
	 */
	renamePath(oldPath: string, newPath: string): boolean {
		const from = normalizeKey(oldPath);
		let changed = false;
		for (const manifest of this.manifests.values()) {
			for (const file of Object.values(manifest.files)) {
				if (normalizeKey(file.path) === from) {
					file.path = newPath;
					changed = true;
				}
			}
		}
		if (changed) this.reindex();
		return changed;
	}

	toRecord(): Record<string, ImportManifest> {
		return Object.fromEntries(this.manifests);
	}
}
