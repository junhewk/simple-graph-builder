/**
 * Carrying out a file plan in the vault.
 *
 * The plan was made from a read of the vault; by the time a write happens the
 * person may have edited the file again. Every write therefore re-checks:
 * overwrites go through `vault.process` and only replace text whose hash still
 * matches what was planned, and trashing re-reads first. A file that changed in
 * between is left alone and reported as a conflict, exactly as if the plan had
 * seen the edit.
 *
 * Renames use `vault.rename`, not `fileManager.renameFile`: the latter rewrites
 * links across the vault, which would edit other imported pages under the
 * plugin's feet and make them look locally changed on the next update. The
 * link rewrite already points every imported page at the new path.
 */
import { TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { ensureFolder } from '../sync/entity-notes';
import { hashContent, type FileAction, type FileActionKind, type FilePlan } from './plan';
import type { FileKey, ImportManifest, ManifestFile } from './types';

export interface FileOutcome {
	key: FileKey;
	/** What actually happened, which can differ from the plan after a race. */
	kind: FileActionKind;
	path: string;
	error?: string;
}

export interface ApplyFilesResult {
	files: Record<FileKey, ManifestFile>;
	outcomes: FileOutcome[];
	/** Vault paths whose content or location changed in this run. */
	touched: string[];
	cancelled: boolean;
}

export interface ApplyOptions {
	onProgress?: (done: number, total: number) => void;
	isCancelled?: () => boolean;
}

function parentOf(path: string): string {
	const slash = path.lastIndexOf('/');
	return slash === -1 ? '' : path.slice(0, slash);
}

function fileAt(plugin: SimpleGraphBuilderPlugin, path: string): TFile | null {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

/** Order matters: free paths before taking them. */
const ORDER: Record<FileActionKind, number> = {
	trash: 0, release: 0, gone: 0,
	overwrite: 1, unchanged: 1, adopt: 1,
	create: 2,
	'keep-local': 3, conflict: 3, 'locally-deleted': 3, occupied: 3,
};

export async function applyFilePlan(
	plugin: SimpleGraphBuilderPlugin,
	plan: FilePlan,
	previous: ImportManifest | null,
	options: ApplyOptions = {}
): Promise<ApplyFilesResult> {
	const { vault } = plugin.app;
	const guard = plugin.writeGuard;
	const files: Record<FileKey, ManifestFile> = {};
	const outcomes: FileOutcome[] = [];
	const touched: string[] = [];
	const actions = [...plan.actions].sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
	let cancelled = false;

	const keep = (action: FileAction, path: string, baseHash: string | undefined) => {
		if (baseHash !== undefined) files[action.key] = { path, rel: action.rel, baseHash };
	};
	const prevBase = (action: FileAction) => previous?.files[action.key]?.baseHash;

	for (const [index, action] of actions.entries()) {
		options.onProgress?.(index + 1, actions.length);
		if (options.isCancelled?.()) {
			cancelled = true;
			// Whatever was not reached stays as the previous import left it.
			const prev = previous?.files[action.key];
			if (prev) files[action.key] = prev;
			continue;
		}

		let kind = action.kind;
		let path = action.path;
		let error: string | undefined;

		try {
			switch (action.kind) {
				case 'trash': {
					const file = fileAt(plugin, action.path);
					if (!file) { kind = 'gone'; break; }
					if (hashContent(await vault.read(file)) !== action.baseHash) { kind = 'release'; break; }
					await guard.guard(action.path, () => plugin.app.fileManager.trashFile(file));
					touched.push(action.path);
					break;
				}
				case 'release':
				case 'gone':
				case 'occupied':
					break;
				case 'keep-local':
				case 'conflict':
				case 'locally-deleted':
					keep(action, action.path, prevBase(action));
					break;
				case 'unchanged':
				case 'adopt':
				case 'overwrite': {
					if (action.moveFrom) {
						const source = fileAt(plugin, action.moveFrom);
						if (source && !vault.getAbstractFileByPath(action.path)) {
							await ensureFolder(plugin, parentOf(action.path));
							await guard.guard(action.moveFrom, () => guard.guard(action.path, () => vault.rename(source, action.path)));
							touched.push(action.moveFrom, action.path);
						} else {
							// Could not move: stay where it is, and treat it as a local divergence.
							path = action.moveFrom;
							kind = 'conflict';
							keep(action, path, prevBase(action));
							break;
						}
					}

					if (action.kind !== 'overwrite') {
						keep(action, path, action.theirsHash);
						break;
					}

					const file = fileAt(plugin, path);
					if (!file) { kind = 'locally-deleted'; keep(action, path, prevBase(action)); break; }
					let written = false;
					await guard.guard(path, () => vault.process(file, current => {
						if (hashContent(current) !== action.oursHash) return current;
						written = true;
						return action.content!;
					}));
					if (written) {
						touched.push(path);
						keep(action, path, action.theirsHash);
					} else {
						kind = 'conflict';
						keep(action, path, prevBase(action));
					}
					break;
				}
				case 'create': {
					if (vault.getAbstractFileByPath(path)) {
						kind = 'occupied';
						keep(action, path, prevBase(action));
						break;
					}
					await ensureFolder(plugin, parentOf(path));
					await guard.guard(path, () => vault.create(path, action.content!));
					touched.push(path);
					keep(action, path, action.theirsHash);
					break;
				}
			}
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			console.error(`Simple Graph Builder: import could not handle ${path}`, e);
			const prev = previous?.files[action.key];
			if (prev) files[action.key] = prev;
		}

		outcomes.push({ key: action.key, kind, path, error });
	}

	return { files, outcomes, touched, cancelled };
}
