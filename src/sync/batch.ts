/**
 * Vault-wide write-back, and the undo for it.
 *
 * Turning the feature on mid-vault would otherwise only affect notes analyzed
 * from then on, leaving a half-linked vault. This applies the current graph to
 * every note it came from in one pass.
 *
 * Unlike vault analysis there are no API calls here, so there is nothing to rate
 * limit -- the only pacing is yielding often enough that Obsidian stays
 * responsive.
 */
import { Notice, TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { isNoteNode } from '../types';
import { upsertEntityNotes, isEntityNotePath } from './entity-notes';
import { clearRelatedProperty, writeRelatedProperty } from './related';

const YIELD_EVERY = 20;

const state = { isRunning: false, isCancelled: false };

export interface WriteBackResult {
	/** Entity notes that did not exist before. */
	entityNotesCreated: number;
	/** Entity notes that existed and whose contents changed. Disjoint from above. */
	entityNotesUpdated: number;
	/** Notes whose link property changed. */
	notesUpdated: number;
	cancelled: boolean;
}

/** Let Obsidian repaint between batches of writes. */
function yieldToUi(): Promise<void> {
	return new Promise(resolve => window.setTimeout(resolve, 0));
}

export function isWritebackRunning(): boolean {
	return state.isRunning;
}

export function cancelWriteback(): void {
	state.isCancelled = true;
}

/** Notes the graph knows about, as files that still exist. */
function analyzedFiles(plugin: SimpleGraphBuilderPlugin): TFile[] {
	const paths = new Set<string>();
	for (const node of plugin.graphCache.getAllNodes()) {
		if (isNoteNode(node)) continue;
		for (const path of node.sourceNotes) paths.add(path);
	}

	const files: TFile[] = [];
	for (const path of paths) {
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile && !isEntityNotePath(plugin.settings, file.path)) files.push(file);
	}
	return files;
}

/**
 * Write entity notes for the whole graph, then the `related:` property for every
 * note that contributed to it.
 *
 * Entity notes are done first, and in a single batch, so that every relationship
 * link has a resolved target and no two entities race for the same filename.
 */
export async function writeLinksForVault(
	plugin: SimpleGraphBuilderPlugin
): Promise<WriteBackResult> {
	if (state.isRunning) {
		new Notice('Link write-back is already running');
		return { entityNotesCreated: 0, entityNotesUpdated: 0, notesUpdated: 0, cancelled: false };
	}
	if (!plugin.settings.enableEntityNotes) {
		new Notice('Turn on "Create entity notes" first.');
		return { entityNotesCreated: 0, entityNotesUpdated: 0, notesUpdated: 0, cancelled: false };
	}

	state.isRunning = true;
	state.isCancelled = false;

	const entities = plugin.graphCache.getAllNodes().filter(n => !isNoteNode(n));
	const files = analyzedFiles(plugin);
	const progress = new Notice(`Writing entity notes for ${entities.length} entities...`, 0);

	let entityNotesCreated = 0;
	let entityNotesUpdated = 0;
	let notesUpdated = 0;
	let cancelled = false;

	try {
		const result = await upsertEntityNotes(plugin, entities, {
			beforeEach: async (done, total, node) => {
				if (state.isCancelled) return false;
				if (done % YIELD_EVERY === 0) {
					progress.setMessage(`Writing entity notes: ${done}/${total}\n${node.properties.name}`);
					await yieldToUi();
				}
				return true;
			},
		});
		entityNotesCreated = result.created;
		entityNotesUpdated = result.updated;

		if (plugin.settings.enableRelatedWriteback) {
			for (let i = 0; i < files.length; i++) {
				if (state.isCancelled) break;

				progress.setMessage(`Writing links: ${i + 1}/${files.length}\n${files[i].basename}`);
				try {
					if (await writeRelatedProperty(plugin, files[i])) notesUpdated++;
				} catch (error) {
					console.error(`Simple Graph Builder: could not write links into ${files[i].path}`, error);
				}

				if (i % YIELD_EVERY === 0) await yieldToUi();
			}
		}

		await plugin.graphCache.flush();
		cancelled = state.isCancelled;
		progress.hide();

		const summary =
			`Entity notes: ${entityNotesCreated} created, ${entityNotesUpdated} updated\n` +
			`Notes updated: ${notesUpdated}`;
		new Notice(cancelled ? `Link write-back cancelled.\n${summary}` : `Links written.\n${summary}`);
	} catch (error) {
		progress.hide();
		console.error('Simple Graph Builder: vault write-back failed', error);
		new Notice('Link write-back failed. See the console for details.');
	} finally {
		state.isRunning = false;
		state.isCancelled = false;
	}

	return { entityNotesCreated, entityNotesUpdated, notesUpdated, cancelled };
}

/**
 * Remove the `related:` property from every note that has one.
 *
 * Entity notes are deliberately left in place: they may carry text the user
 * wrote, and deleting a folder of notes is not something to do on their behalf.
 */
export async function removeWrittenLinks(
	plugin: SimpleGraphBuilderPlugin
): Promise<{ notesCleaned: number }> {
	if (state.isRunning) {
		new Notice('Another write-back run is in progress');
		return { notesCleaned: 0 };
	}

	state.isRunning = true;
	const files = plugin.app.vault.getMarkdownFiles();
	const progress = new Notice('Removing written links...', 0);
	let notesCleaned = 0;

	try {
		for (let i = 0; i < files.length; i++) {
			if (state.isCancelled) break;
			try {
				if (await clearRelatedProperty(plugin, files[i])) notesCleaned++;
			} catch (error) {
				console.error(`Simple Graph Builder: could not clean ${files[i].path}`, error);
			}
			if (i % YIELD_EVERY === 0) await yieldToUi();
		}
	} finally {
		progress.hide();
		state.isRunning = false;
		state.isCancelled = false;
	}

	new Notice(`Removed the link property from ${notesCleaned} notes.\nEntity notes were left in place.`);
	return { notesCleaned };
}
