/**
 * Deciding what an import does to each file, before touching any.
 *
 * Every file is a three-way merge between
 *
 *   base    what the plugin last wrote (or found already in place),
 *   ours    what is in the vault now,
 *   theirs  what the new snapshot says, with its links rewritten.
 *
 * The rule throughout is that the person's edits win: a file is only replaced
 * while it still holds exactly what the plugin put there, and only removed on
 * the same condition. Everything else is kept and reported.
 *
 * Kept free of Obsidian so the whole decision table can be tested directly;
 * the vault is reached through `read` alone.
 */
import { computeHash } from '../graph/hashes';
import { nameIndex, toWikilinks } from './links';
import { compareMarkers, normalizeContent } from './snapshot';
import type { FileKey, ImportManifest, MedLitSnapshot } from './types';

export type FileActionKind =
	/** Not imported before, nothing at the path: write it. */
	| 'create'
	/** Unchanged locally since the last import, changed upstream: replace it. */
	| 'overwrite'
	/** Same as last time on both sides. */
	| 'unchanged'
	/** The vault already holds exactly the new text: take ownership as is. */
	| 'adopt'
	/** Edited locally, unchanged upstream: nothing to do. */
	| 'keep-local'
	/** Edited locally and changed upstream: keep the local text, report it. */
	| 'conflict'
	/** Imported before, deleted from the vault since: not brought back. */
	| 'locally-deleted'
	/** Never imported, but some other file already sits at the path. */
	| 'occupied'
	/** Gone upstream, untouched locally: move to the trash. */
	| 'trash'
	/** Gone upstream, but edited locally: keep it, stop tracking it. */
	| 'release'
	/** Gone upstream and already gone locally. */
	| 'gone';

export interface FileAction {
	key: FileKey;
	kind: FileActionKind;
	/** Where the file is (or will be) in the vault. */
	path: string;
	/** Relative path inside the project, as med-lit named it. */
	rel: string;
	/** When upstream renamed the page: where it is now, before the move. */
	moveFrom?: string;
	/** The rewritten text and its hash, for anything that writes. */
	content?: string;
	theirsHash?: string;
	/** Hash of what the vault held when planned; null when nothing was there. */
	oursHash: string | null;
	/** The previous merge base, when there is one. */
	baseHash?: string;
}

export interface FilePlan {
	projectId: string;
	folder: string;
	isUpdate: boolean;
	/** The snapshot is older than the one imported last. */
	older: boolean;
	actions: FileAction[];
}

export interface PlanInput {
	manifest: ImportManifest | null;
	snapshot: MedLitSnapshot;
	/** Vault folder for a first import; an update keeps the manifest's. */
	folder: string;
	/** Current text of a vault file, or null when there is none. */
	read: (path: string) => Promise<string | null>;
	/** Keys the person asked to overwrite despite local edits. */
	force?: ReadonlySet<FileKey>;
}

export function hashContent(text: string): string {
	return computeHash(normalizeContent(text));
}

export function joinPath(folder: string, rel: string): string {
	const clean = folder.replace(/^\/+|\/+$/g, '');
	return clean ? `${clean}/${rel}` : rel;
}

/** Actions that leave the file owned by the import afterwards. */
export function isOwnedAfter(kind: FileActionKind): boolean {
	return kind !== 'occupied' && kind !== 'trash' && kind !== 'release' && kind !== 'gone';
}

/** Actions that write the snapshot's text into the vault. */
export function writesContent(kind: FileActionKind): boolean {
	return kind === 'create' || kind === 'overwrite';
}

export async function planFiles(input: PlanInput): Promise<FilePlan> {
	const { manifest, snapshot } = input;
	const folder = manifest?.vaultFolder ?? input.folder;
	const force = input.force ?? new Set<FileKey>();
	const previous = manifest?.files ?? {};
	const actions: FileAction[] = [];

	// Pass 1: where every snapshot file goes. A path stays wherever it is now --
	// including where the person moved it -- unless med-lit itself renamed the
	// page and the file is still where the plugin put it.
	const pathByKey = new Map<FileKey, string>();
	const moveFrom = new Map<FileKey, string>();
	for (const file of snapshot.files) {
		const prev = previous[file.key];
		if (!prev) {
			pathByKey.set(file.key, joinPath(folder, file.rel));
			continue;
		}
		if (prev.rel === file.rel || prev.path !== joinPath(folder, prev.rel)) {
			pathByKey.set(file.key, prev.path);
			continue;
		}
		const next = joinPath(folder, file.rel);
		pathByKey.set(file.key, next);
		if (next !== prev.path) moveFrom.set(file.key, prev.path);
	}

	// Pass 2: rewrite links against those paths.
	const pathByRel = new Map<string, string>();
	for (const file of snapshot.files) pathByRel.set(file.rel, pathByKey.get(file.key)!);
	const pageNames = snapshot.files
		.filter(f => f.key.startsWith('entity:') || f.key.startsWith('source:'))
		.map(f => pathByKey.get(f.key)!);
	const ctx = { pathForRel: (rel: string) => pathByRel.get(rel), pathForName: nameIndex(pageNames) };

	// Pass 3a: files med-lit no longer has. Done first so a path they free can
	// be taken by a new page in the same run.
	const freed = new Set<string>();
	const inSnapshot = new Set(snapshot.files.map(f => f.key));
	for (const [key, prev] of Object.entries(previous)) {
		if (inSnapshot.has(key)) continue;
		const ours = await input.read(prev.path);
		const oursHash = ours === null ? null : hashContent(ours);
		const kind: FileActionKind = ours === null ? 'gone' : oursHash === prev.baseHash ? 'trash' : 'release';
		if (kind === 'trash') freed.add(prev.path);
		actions.push({ key, kind, path: prev.path, rel: prev.rel, oursHash, baseHash: prev.baseHash });
	}

	// Pass 3b: the merge proper.
	for (const file of snapshot.files) {
		const prev = previous[file.key];
		const path = pathByKey.get(file.key)!;
		const from = moveFrom.get(file.key);
		const content = toWikilinks(file.content, file.rel, ctx);
		const theirsHash = hashContent(content);

		const where = from ?? path;
		const ours = freed.has(where) ? null : await input.read(where);
		const oursHash = ours === null ? null : hashContent(ours);

		let kind: FileActionKind;
		if (!prev) {
			kind = ours === null ? 'create' : oursHash === theirsHash ? 'adopt' : 'occupied';
		} else if (ours === null) {
			kind = 'locally-deleted';
		} else if (oursHash === theirsHash) {
			kind = oursHash === prev.baseHash ? 'unchanged' : 'adopt';
		} else if (oursHash === prev.baseHash) {
			kind = 'overwrite';
		} else if (theirsHash === prev.baseHash) {
			kind = 'keep-local';
		} else {
			kind = 'conflict';
		}

		if (force.has(file.key)) {
			if (kind === 'conflict' || kind === 'keep-local' || kind === 'occupied') kind = 'overwrite';
			else if (kind === 'locally-deleted') kind = 'create';
		}

		// A move only happens alongside a change the plugin is allowed to make.
		const moves = from !== undefined && (kind === 'overwrite' || kind === 'unchanged' || kind === 'adopt');
		actions.push({
			key: file.key,
			kind,
			path: from !== undefined && !moves ? from : path,
			rel: file.rel,
			moveFrom: moves ? from : undefined,
			content,
			theirsHash,
			oursHash,
			baseHash: prev?.baseHash,
		});
	}

	return {
		projectId: snapshot.project.id,
		folder,
		isUpdate: manifest !== null,
		older: manifest !== null && compareMarkers(snapshot.marker, manifest.marker) < 0,
		actions,
	};
}

export type PlanCounts = Record<FileActionKind, number>;

export function countKinds(kinds: Iterable<FileActionKind>): PlanCounts {
	const counts: PlanCounts = {
		create: 0, overwrite: 0, unchanged: 0, adopt: 0, 'keep-local': 0, conflict: 0,
		'locally-deleted': 0, occupied: 0, trash: 0, release: 0, gone: 0,
	};
	for (const kind of kinds) counts[kind]++;
	return counts;
}

export function countActions(plan: FilePlan): PlanCounts {
	return countKinds(plan.actions.map(a => a.kind));
}
