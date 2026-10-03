/**
 * Importing, updating and removing med-lit projects.
 *
 * An import is three steps, each safe to repeat:
 *
 *   1. files   three-way merge of the project's pages into its vault folder
 *   2. graph   resolve its entities against the graph, then reconcile
 *   3. links   once Obsidian has indexed the new pages, rebuild the note layer
 *
 * "Update" is the same operation on a newer snapshot of a project already
 * imported -- recognized by med-lit's project id, wherever the folder now is.
 */
import { App, TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { rebuildNoteLayer } from '../graph/merge';
import { isAnalyzingVault } from '../commands/analyze';
import { isWritebackRunning } from '../sync/batch';
import { normalizeKey } from '../types';
import { applyFilePlan, FileOutcome } from './apply-files';
import { deleteKg, loadKg, saveKg } from './kg-store';
import { countActions, countKinds, FilePlan, hashContent, planFiles, PlanCounts } from './plan';
import { createNodeFsReader, SnapshotReader } from './reader';
import { reconcileProjectGraph, ReconcileReport } from './reconcile';
import { resolveProjectEntities } from './resolve';
import { readMedLitSnapshot } from './snapshot';
import { ImportError } from './errors';
import type { FileKey, ImportManifest, MedLitKg, MedLitSnapshot } from './types';

export { ImportError };

export interface PreparedImport {
	sourcePath: string;
	snapshot: MedLitSnapshot;
	previous: ImportManifest | null;
	plan: FilePlan;
	counts: PlanCounts;
}

export interface GraphSyncResult {
	graph: ReconcileReport;
	resolved: number;
	reused: number;
	matchedExisting: number;
}

export interface ImportReport extends GraphSyncResult {
	projectId: string;
	name: string;
	folder: string;
	isUpdate: boolean;
	outcomes: FileOutcome[];
	counts: PlanCounts;
	warnings: string[];
	cancelled: boolean;
}

const state = { running: false, cancelled: false };

export function isImportRunning(): boolean {
	return state.running;
}

export function cancelImport(): void {
	state.cancelled = true;
}

/** Characters Obsidian (or a wikilink to the folder) cannot carry. */
export function sanitizeFolder(folder: string): string {
	return folder
		.split('/')
		.map(segment => segment.replace(/[\\:*?"<>|#^[\]]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, ''))
		.filter(Boolean)
		.join('/');
}

function busyReason(): string | null {
	if (state.running) return 'An import is already running.';
	if (isAnalyzingVault()) return 'Vault analysis is running. Wait for it to finish, then import.';
	if (isWritebackRunning()) return 'Link write-back is running. Wait for it to finish, then import.';
	return null;
}

async function readVaultText(plugin: SimpleGraphBuilderPlugin, path: string): Promise<string | null> {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? plugin.app.vault.read(file) : null;
}

/** Read the source folder and work out what an import would do. Writes nothing. */
export async function prepareImport(
	plugin: SimpleGraphBuilderPlugin,
	sourcePath: string,
	options: { folder?: string; force?: ReadonlySet<FileKey> } = {}
): Promise<PreparedImport> {
	const reader = createNodeFsReader(sourcePath.trim());
	if (!reader) throw new ImportError('Importing a med-lit project needs the desktop app: it reads a folder outside the vault.');
	return prepareFromReader(plugin, reader, sourcePath.trim(), options);
}

/** The same, over any reader. Split out so it can be exercised without a disk. */
export async function prepareFromReader(
	plugin: SimpleGraphBuilderPlugin,
	reader: SnapshotReader,
	sourcePath: string,
	options: { folder?: string; force?: ReadonlySet<FileKey> } = {}
): Promise<PreparedImport> {
	const snapshot = await readMedLitSnapshot(reader);
	const previous = plugin.imports.get(snapshot.project.id) ?? null;
	const folder = previous?.vaultFolder ?? sanitizeFolder(options.folder ?? snapshot.project.name);
	if (!folder) throw new ImportError('Choose a folder to import into.');

	if (!previous) {
		const prefix = `${normalizeKey(folder)}/`;
		for (const other of plugin.imports.all()) {
			if (Object.values(other.files).some(f => normalizeKey(f.path).startsWith(prefix))) {
				throw new ImportError(`"${folder}" already holds the imported project "${other.name}". Choose another folder.`);
			}
		}
	}

	const plan = await planFiles({
		manifest: previous,
		snapshot,
		folder,
		read: path => readVaultText(plugin, path),
		force: options.force,
	});
	return { sourcePath, snapshot, previous, plan, counts: countActions(plan) };
}

/**
 * Bring the graph in line with a project: resolve its entities (reusing past
 * decisions), then reconcile. `previous` supplies the paths the project owned
 * before, so pages it no longer has stop counting as sources.
 */
export async function syncProjectGraph(
	plugin: SimpleGraphBuilderPlugin,
	manifest: ImportManifest,
	kg: MedLitKg | null,
	previous: ImportManifest | null,
	options: { useEmbeddings: boolean }
): Promise<GraphSyncResult> {
	const cache = plugin.graphCache;
	let resolved = 0;
	let reused = 0;
	let matchedExisting = 0;

	if (kg) {
		const result = await resolveProjectEntities(
			cache,
			plugin.settings,
			kg,
			{ ...(previous?.entityMap ?? {}), ...manifest.entityMap },
			options
		);
		manifest.entityMap = result.entityMap;
		({ resolved, reused, matchedExisting } = result);
	}

	const exists = (path: string) => plugin.app.vault.getAbstractFileByPath(path) instanceof TFile;
	const graph = reconcileProjectGraph(cache, {
		projectId: manifest.projectId,
		kg,
		entityMap: manifest.entityMap,
		pathOf: key => {
			const file = manifest.files[key];
			return file && exists(file.path) ? file.path : undefined;
		},
		ownedPaths: [
			...Object.values(previous?.files ?? {}).map(f => f.path),
			...Object.values(manifest.files).map(f => f.path),
		],
	});
	return { graph, resolved, reused, matchedExisting };
}

function waitForLinkIndex(app: App, timeoutMs: number): Promise<void> {
	return new Promise(resolve => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			app.metadataCache.offref(ref);
			window.clearTimeout(timer);
			resolve();
		};
		const ref = app.metadataCache.on('resolved', finish);
		const timer = window.setTimeout(finish, timeoutMs);
	});
}

/** The note layer reads Obsidian's link index, which lags behind new files. */
async function refreshNoteLayer(plugin: SimpleGraphBuilderPlugin, filesChanged: boolean): Promise<void> {
	if (filesChanged) await waitForLinkIndex(plugin.app, 5000);
	rebuildNoteLayer(plugin.graphCache, plugin.app);
	await plugin.graphCache.flush();
	plugin.updateStatusBar();
}

function saveManifests(plugin: SimpleGraphBuilderPlugin): void {
	plugin.graphCache.setImports(plugin.imports.toRecord());
}

export async function executeImport(
	plugin: SimpleGraphBuilderPlugin,
	prepared: PreparedImport,
	options: { useEmbeddings: boolean; onProgress?: (message: string) => void }
): Promise<ImportReport> {
	const busy = busyReason();
	if (busy) throw new ImportError(busy);

	const { snapshot, previous, plan } = prepared;
	const pid = plan.projectId;
	state.running = true;
	state.cancelled = false;
	plugin.imports.claim(pid, plan.actions.map(a => a.path));

	try {
		const files = await applyFilePlan(plugin, plan, previous, {
			onProgress: (done, total) => options.onProgress?.(`Writing pages: ${done}/${total}`),
			isCancelled: () => state.cancelled,
		});

		const manifest: ImportManifest = {
			version: 1,
			projectId: pid,
			name: snapshot.project.name,
			vaultFolder: plan.folder,
			lastSourcePath: prepared.sourcePath,
			importedAt: Date.now(),
			// A cancelled run did not take in the whole snapshot.
			marker: files.cancelled && previous ? previous.marker : snapshot.marker,
			files: files.files,
			entityMap: {},
		};

		options.onProgress?.('Matching entities with the graph...');
		await saveKg(plugin, pid, snapshot.kg);
		const graph = await syncProjectGraph(plugin, manifest, snapshot.kg, previous, options);

		plugin.imports.upsert(manifest);
		saveManifests(plugin);
		await plugin.graphCache.flush();

		options.onProgress?.('Linking pages...');
		await refreshNoteLayer(plugin, files.touched.length > 0);

		const counts = countKinds(files.outcomes.map(o => o.kind));
		return {
			...graph,
			projectId: pid,
			name: manifest.name,
			folder: manifest.vaultFolder,
			isUpdate: previous !== null,
			outcomes: files.outcomes,
			counts,
			warnings: snapshot.warnings,
			cancelled: files.cancelled,
		};
	} finally {
		plugin.imports.releaseClaims(pid);
		state.running = false;
		state.cancelled = false;
	}
}

/** Re-derive a project's part of the graph from the stored copy. No source folder needed. */
export async function rebuildImportGraph(plugin: SimpleGraphBuilderPlugin, projectId: string): Promise<GraphSyncResult> {
	const busy = busyReason();
	if (busy) throw new ImportError(busy);
	const manifest = plugin.imports.get(projectId);
	if (!manifest) throw new ImportError('This project is not imported.');
	const kg = await loadKg(plugin, projectId);
	if (!kg) throw new ImportError('No stored graph for this project. Update it from its med-lit folder instead.');

	state.running = true;
	try {
		const result = await syncProjectGraph(plugin, manifest, kg, manifest, { useEmbeddings: false });
		plugin.imports.upsert(manifest);
		saveManifests(plugin);
		await refreshNoteLayer(plugin, false);
		return result;
	} finally {
		state.running = false;
	}
}

/**
 * Take a project out of the graph and stop tracking its files. With
 * `trashFiles`, pages still exactly as imported go to the trash; edited ones
 * stay, and are returned.
 */
export async function removeImport(
	plugin: SimpleGraphBuilderPlugin,
	projectId: string,
	options: { trashFiles: boolean }
): Promise<{ graph: ReconcileReport; trashed: number; kept: string[] }> {
	const busy = busyReason();
	if (busy) throw new ImportError(busy);
	const manifest = plugin.imports.get(projectId);
	if (!manifest) throw new ImportError('This project is not imported.');

	state.running = true;
	try {
		const { graph } = await syncProjectGraph(plugin, { ...manifest, files: {} }, null, manifest, { useEmbeddings: false });

		let trashed = 0;
		const kept: string[] = [];
		if (options.trashFiles) {
			for (const file of Object.values(manifest.files)) {
				const existing = plugin.app.vault.getAbstractFileByPath(file.path);
				if (!(existing instanceof TFile)) continue;
				if (hashContent(await plugin.app.vault.read(existing)) !== file.baseHash) {
					kept.push(file.path);
					continue;
				}
				await plugin.writeGuard.guard(file.path, () => plugin.app.fileManager.trashFile(existing));
				trashed++;
			}
		}

		plugin.imports.remove(projectId);
		saveManifests(plugin);
		await deleteKg(plugin, projectId);
		await refreshNoteLayer(plugin, false);
		return { graph, trashed, kept };
	} finally {
		state.running = false;
	}
}
