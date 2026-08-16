/**
 * Turning an entity name into a vault filename.
 *
 * Entity names come from an LLM, so they contain anything: slashes, colons,
 * newlines, `[[`, emoji, 300-character phrases. Names are also the plugin's
 * identity for an entity, which means the mapping has to be deterministic --
 * the same entity must land on the same file every run, or each analysis
 * creates a new note.
 */
import { OntologyNode, normalizeUnicode } from '../types';
import { computeHash } from '../graph/hashes';

/**
 * Characters that cannot appear in a filename, or cannot appear in a wikilink
 * target. `\ / :` are path syntax, `# ^ | [ ]` end a link early, and `? * " < >`
 * are illegal on Windows.
 */
const ILLEGAL = /[\\/:#^|[\]?*"<>]/g;

/** Windows refuses these as basenames regardless of extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MAX_LENGTH = 100;
const DEL = 127;
const FIRST_PRINTABLE = 32;

/** Control characters have no regex here so the source stays free of escapes. */
function blankControls(text: string): string {
	let out = '';
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		out += code < FIRST_PRINTABLE || code === DEL ? ' ' : ch;
	}
	return out;
}

/**
 * A safe, human-readable basename for an entity. Never empty.
 */
export function sanitizeFileName(name: string): string {
	const cleaned = blankControls(normalizeUnicode(name).replace(ILLEGAL, ' '))
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_LENGTH)
		// Obsidian rejects leading dots, and a trailing dot or space left by the
		// length cap is silently dropped by some filesystems.
		.replace(/^\.+/, '')
		.replace(/[.\s]+$/, '');

	if (!cleaned) return 'entity';
	return RESERVED.test(cleaned) ? `${cleaned} entity` : cleaned;
}

/** Short, stable discriminator derived from the node id. */
function shortHash(id: string): string {
	return computeHash(id).slice(0, 6);
}

/**
 * Basenames to try, in order, for one entity.
 *
 * The plain name is what a user wants to see. Two entities can still collide on
 * it -- different types with the same name ("Apple" the ORGANIZATION and
 * "Apple" the CONCEPT), a name that only differs in a character sanitizing
 * removed, or a file the user already owns. The type suffix resolves the common
 * case readably; the id hash is the guaranteed-unique fallback.
 */
export function fileNameCandidates(node: OntologyNode): string[] {
	const base = sanitizeFileName(node.properties.name);
	return [base, `${base} (${node.entityType})`, `${base} (${shortHash(node.id)})`];
}

/** Folder setting without its surrounding slashes; '' when blank. */
export function normalizeFolder(folder: string): string {
	return folder.replace(/^\/+|\/+$/g, '').trim();
}

/** Where an entity note lives, given a folder setting and a chosen basename. */
export function entityNotePath(folder: string, baseName: string): string {
	const clean = normalizeFolder(folder);
	return clean ? `${clean}/${baseName}.md` : `${baseName}.md`;
}
