/**
 * The `related:` property: a note's own entities, as links it can be found by.
 *
 * Written into frontmatter rather than into the prose because the extractor
 * returns canonical entity names, not the words the note actually used -- it
 * expands acronyms and strips Korean particles, so "머신러닝을" comes back as
 * "머신러닝". There is no reliable way to point at the original mention, and
 * guessing would edit sentences the user wrote. A property is exact, reversible,
 * and still gives Obsidian everything it needs: the links show up in the graph
 * view, in backlinks, and in the properties panel.
 */
import { TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { OntologyNode, isNoteNode, normalizeKey } from '../types';
import { renderEntityLink } from './render';
import { normalizeFolder } from './filenames';
import { isEntityNotePath } from './entity-notes';

/** Entities extracted from a note, in a stable order. */
export function entitiesForNote(plugin: SimpleGraphBuilderPlugin, notePath: string): OntologyNode[] {
	return plugin.graphCache
		.getNodesBySourceNote(notePath)
		.filter(n => !isNoteNode(n));
}

/**
 * The links a note's `related:` property should hold.
 *
 * Sorted so an unchanged note produces a byte-identical list and the write can
 * be skipped. Entities without an entity note are left out: a link to a file
 * that will never exist is noise in the graph.
 */
export function computeRelatedLinks(plugin: SimpleGraphBuilderPlugin, notePath: string): string[] {
	const links: string[] = [];

	for (const node of entitiesForNote(plugin, notePath)) {
		const path = node.properties.entityNotePath;
		if (typeof path !== 'string' || !path) continue;
		links.push(renderEntityLink(path, node.properties.name));
	}

	return links.sort();
}

function sameLinks(current: unknown, next: string[]): boolean {
	const existing = Array.isArray(current) ? current : current == null ? [] : [current];
	if (existing.length !== next.length) return false;
	return next.every((link, i) => String(existing[i]) === link);
}

/**
 * Put the current entity links in the note's frontmatter.
 *
 * The property is owned wholesale by the plugin: it is replaced, and removed
 * entirely when a note has no entities left. Returns true only if the file was
 * actually written, so callers can report what they touched -- and so an
 * unchanged note never fires a modify event.
 */
export async function writeRelatedProperty(
	plugin: SimpleGraphBuilderPlugin,
	file: TFile
): Promise<boolean> {
	const settings = plugin.settings;
	if (!settings.enableRelatedWriteback) return false;
	if (isEntityNotePath(settings, file.path)) return false;

	const key = settings.relatedPropertyName || 'related';
	const links = computeRelatedLinks(plugin, file.path);
	const current = plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[key];

	if (sameLinks(current, links)) return false;
	if (links.length === 0 && current === undefined) return false;

	await plugin.writeGuard.guard(file.path, () =>
		plugin.app.fileManager.processFrontMatter(file, fm => {
			if (links.length > 0) fm[key] = links;
			else delete fm[key];
		})
	);

	return true;
}

/** True for a value this plugin wrote: a wikilink into the entity folder. */
function isPluginLink(value: unknown, settings: SimpleGraphBuilderPlugin['settings']): boolean {
	if (typeof value !== 'string') return false;
	const target = /^\[\[([^\]|#]+)/.exec(value.trim())?.[1];
	if (!target) return false;
	const folder = normalizeFolder(settings.entityFolder);
	return folder ? normalizeKey(target).startsWith(`${normalizeKey(folder)}/`) : false;
}

/**
 * Take the plugin's links back out of a note.
 *
 * Only entries that point into the entity folder are removed, and the property
 * itself only disappears once nothing is left. `related` is the default name
 * and a very common hand-authored property -- deleting the key outright would
 * wipe a user's own list on any vault where the two happened to collide.
 */
export async function clearRelatedProperty(
	plugin: SimpleGraphBuilderPlugin,
	file: TFile
): Promise<boolean> {
	const key = plugin.settings.relatedPropertyName || 'related';
	const current = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	if (!current || !(key in current)) return false;

	const value = current[key];
	const entries = Array.isArray(value) ? value : [value];
	const keep = entries.filter(entry => !isPluginLink(entry, plugin.settings));
	if (keep.length === entries.length) return false;

	await plugin.writeGuard.guard(file.path, () =>
		plugin.app.fileManager.processFrontMatter(file, fm => {
			if (keep.length > 0) fm[key] = keep;
			else delete fm[key];
		})
	);

	return true;
}
