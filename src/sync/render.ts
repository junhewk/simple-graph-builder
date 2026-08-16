/**
 * Rendering the text the plugin owns inside the vault.
 *
 * Pure string functions, kept apart from the Obsidian calls in entity-notes.ts
 * so the tricky part -- staying idempotent across re-analysis, and never eating
 * a user's own edits -- is testable without a vault.
 *
 * The ownership contract: the plugin replaces everything between the two
 * markers below and nothing else. Whatever a user writes above or below them
 * survives every regeneration.
 */
import { OntologyNode, normalizeUnicode } from '../types';

export const MANAGED_START = '%% sgb:managed:start %%';
export const MANAGED_END = '%% sgb:managed:end %%';

/** One outgoing relationship, already resolved to its target's note path. */
export interface RenderedRelationship {
	relationship: string;
	targetName: string;
	targetPath: string;
}

/**
 * A wikilink to an entity note.
 *
 * Written as a full vault path so it cannot be captured by a same-named note
 * elsewhere, with a display alias so the path stays invisible when read. The
 * `.md` extension is dropped because Obsidian's link parser expects a linkpath.
 */
export function renderEntityLink(notePath: string, displayName: string): string {
	const target = notePath.replace(/\.md$/i, '');
	const label = normalizeUnicode(displayName).replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
	const basename = target.slice(target.lastIndexOf('/') + 1);
	return label && label !== basename ? `[[${target}|${label}]]` : `[[${target}]]`;
}

/**
 * The managed body of an entity note: what the entity is, and what it connects
 * to. The relationship list is what puts entity-to-entity edges into Obsidian's
 * own graph view -- without it the native graph would only ever show
 * note-to-entity links.
 */
export function renderManagedBlock(
	node: OntologyNode,
	relationships: RenderedRelationship[],
	includeRelationships: boolean
): string {
	const lines: string[] = [];

	const description = typeof node.properties.description === 'string'
		? node.properties.description.trim()
		: '';
	if (description) lines.push(description, '');

	if (includeRelationships && relationships.length > 0) {
		lines.push('## Relationships', '');
		for (const rel of relationships) {
			lines.push(`- ${rel.relationship} ${renderEntityLink(rel.targetPath, rel.targetName)}`);
		}
		lines.push('');
	}

	// Trailing blank lines would grow the file by one line per save.
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines.join('\n');
}

/**
 * Swap the managed region for fresh content, leaving everything else alone.
 *
 * When only one marker survives, the surviving marker is removed and the text
 * is kept, then a fresh block is appended. Removing the marker is what stops
 * every later write from appending another block; keeping the text is what
 * matters to the user. The markers are `%% %%` comments -- invisible in reading
 * view -- so clipping one while editing around it is an ordinary accident, and
 * whatever sits below it is far more likely to be the user's writing than the
 * plugin's.
 */
export function replaceManagedBlock(content: string, managed: string): string {
	const block = `${MANAGED_START}\n${managed}\n${MANAGED_END}`;

	const start = content.indexOf(MANAGED_START);
	const end = content.indexOf(MANAGED_END, start === -1 ? 0 : start + MANAGED_START.length);

	if (start !== -1 && end !== -1) {
		return content.slice(0, start) + block + content.slice(end + MANAGED_END.length);
	}

	let rest = content;
	if (start !== -1) rest = content.slice(0, start) + content.slice(start + MANAGED_START.length);
	else if (end !== -1) rest = content.slice(0, end) + content.slice(end + MANAGED_END.length);

	const trimmed = rest.replace(/\s+$/, '');
	return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}
