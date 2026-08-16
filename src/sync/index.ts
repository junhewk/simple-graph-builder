/**
 * Vault write-back: turning the extracted graph into real Obsidian links.
 *
 * The plugin's own graph view is one way to look at a vault; Obsidian already
 * has another, and it is the one people use. Writing the graph back as
 * wikilinks means both views show the same structure -- and entity resolution,
 * the part that costs API calls to compute, becomes something Obsidian can use
 * natively through aliases.
 *
 * Every entry point here is a no-op unless the user opted in.
 */
import { Notice, TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { OntologyNode, isNoteNode } from '../types';
import { upsertEntityNotes, isEntityNotePath, isManagedEntityNote } from './entity-notes';
import { entitiesForNote, writeRelatedProperty } from './related';

/**
 * True when a file must be kept out of analysis because the plugin wrote it.
 *
 * Two independent tests, because either can lapse: the folder rule goes quiet
 * when the feature is switched off, and the `sgb-id` marker is missing while
 * Obsidian is still indexing a freshly created file.
 */
export function isPluginManagedNote(plugin: SimpleGraphBuilderPlugin, file: TFile): boolean {
	return isEntityNotePath(plugin.settings, file.path) || isManagedEntityNote(plugin, file);
}

export { WriteGuard } from './write-guard';
export { isEntityNotePath, isManagedEntityNote, upsertEntityNotes, deleteEntityNote, getEntityNoteFile } from './entity-notes';
export { writeRelatedProperty, clearRelatedProperty, computeRelatedLinks } from './related';
export { stripFrontmatter } from './note-content';

/**
 * Every entity whose note this analysis could have changed.
 *
 * Its own entities, obviously -- but also the entity at the *start* of any
 * relationship this note produced, which may have come from a different note.
 * Its note lists outgoing relationships, so leaving it out would let an entity
 * note fall behind the graph until something else happened to rewrite it.
 */
function nodesTouchedBy(plugin: SimpleGraphBuilderPlugin, notePath: string): OntologyNode[] {
	const touched = new Map<string, OntologyNode>();

	for (const node of entitiesForNote(plugin, notePath)) touched.set(node.id, node);

	for (const edge of plugin.graphCache.getEdgesBySourceNote(notePath)) {
		const source = plugin.graphCache.getNodeById(edge.source);
		if (source && !isNoteNode(source)) touched.set(source.id, source);
	}

	return [...touched.values()];
}

/**
 * Sync one note after it has been analyzed: its entities get notes, and the
 * note itself gets links to them.
 *
 * Failures are reported but never rethrown. By the time this runs the analysis
 * has already succeeded and the graph is updated; a vault write that fails --
 * a read-only file, a sync conflict -- must not turn that into an error.
 */
export async function syncNoteWriteback(plugin: SimpleGraphBuilderPlugin, file: TFile): Promise<void> {
	const settings = plugin.settings;
	if (!settings.enableEntityNotes) return;
	if (isEntityNotePath(settings, file.path)) return;

	try {
		await upsertEntityNotes(plugin, nodesTouchedBy(plugin, file.path));
		await writeRelatedProperty(plugin, file);
	} catch (error) {
		console.error('Simple Graph Builder: write-back failed', error);
		new Notice(`Could not write links for "${file.basename}". See the console for details.`);
	}
}
