/**
 * Turning med-lit's links into Obsidian wikilinks.
 *
 * med-lit writes every link as a relative, URL-encoded Markdown link
 * (`[Empathy](../entities/Empathy.md)`), because it does not know where its
 * pages will end up. Obsidian resolves those, but they are not what a vault is
 * written in, and they say nothing about the folder the project now lives in.
 * The importer does know, so it rewrites each link to a full-path wikilink:
 *
 *   [Empathy](../entities/Empathy.md)  ->  [[Project/entities/Empathy|Empathy]]
 *
 * Bot reports already use bare `[[Name]]`. Those are qualified the same way when
 * the name is one of the project's pages, so they cannot resolve to a
 * same-named note elsewhere in the vault (an SGB entity note, say).
 *
 * The rewrite is a pure function of the text and the path map. That matters for
 * updates: the merge compares the rewritten text, and running it again with the
 * same paths must produce byte-identical output.
 */
import { normalizeKey } from '../types';

export interface LinkContext {
	/** Vault path (with .md) of the project file at this relative path. */
	pathForRel(rel: string): string | undefined;
	/** Vault path of the project page a bare `[[Name]]` means. */
	pathForName(name: string): string | undefined;
}

const MARKDOWN_LINK = /(!?)\[([^\]\n]*)\]\(([^)\s]+)\)/g;
const WIKILINK = /\[\[([^[\]|#^\n]+)(#[^[\]|\n]*)?(?:\|([^[\]\n]*))?\]\]/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Characters a wikilink target cannot hold. */
const UNLINKABLE = /[[\]|#^]/;

function joinRel(fromRel: string, target: string): string | null {
	const parts = fromRel.split('/');
	parts.pop();
	for (const segment of target.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else {
			parts.push(segment);
		}
	}
	return parts.join('/');
}

function decode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		return text;
	}
}

function cleanLabel(label: string): string {
	return label.replace(/[[\]|]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * `[[path|label]]`. The label stays even when it repeats the file name: a
 * full-path link without one reads as the whole path.
 */
export function renderWikilink(vaultPath: string, label: string, anchor = ''): string {
	const target = vaultPath.replace(/\.md$/i, '');
	const shown = cleanLabel(label) || target.slice(target.lastIndexOf('/') + 1);
	return `[[${target}${anchor}|${shown}]]`;
}

export function toWikilinks(content: string, fromRel: string, ctx: LinkContext): string {
	const bare = content.replace(WIKILINK, (match: string, target: string, anchor: string | undefined, label: string | undefined) => {
		if (target.includes('/')) return match;
		const path = ctx.pathForName(target.trim());
		if (!path || UNLINKABLE.test(path)) return match;
		return renderWikilink(path, label ?? target.trim(), anchor ?? '');
	});

	return bare.replace(MARKDOWN_LINK, (match: string, bang: string, label: string, href: string) => {
		if (bang || SCHEME.test(href) || href.startsWith('#') || href.startsWith('/')) return match;

		const hash = href.indexOf('#');
		const rawPath = hash === -1 ? href : href.slice(0, hash);
		const anchor = hash === -1 ? '' : decode(href.slice(hash));
		if (!/\.md$/i.test(rawPath)) return match;

		const rel = joinRel(fromRel, decode(rawPath));
		if (rel === null) return match;
		const path = ctx.pathForRel(rel);
		if (!path || UNLINKABLE.test(path)) return match;
		return renderWikilink(path, label, anchor);
	});
}

/** Case-insensitive name lookup over a set of vault paths, by basename. */
export function nameIndex(paths: Iterable<string>): (name: string) => string | undefined {
	const byName = new Map<string, string | null>();
	for (const path of paths) {
		const basename = path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
		const key = normalizeKey(basename);
		// Two pages with one name: ambiguous, so neither wins.
		byName.set(key, byName.has(key) ? null : path);
	}
	return (name: string) => byName.get(normalizeKey(name)) ?? undefined;
}
