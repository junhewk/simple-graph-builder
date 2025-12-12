import type { App, TFile } from 'obsidian';

/**
 * Regular expression to match Obsidian internal links.
 * Matches: [[note]], [[note|alias]], [[note#heading]], [[note#heading|alias]]
 */
const WIKILINK_REGEX = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;

/**
 * Extract all internal links from note content.
 * Returns an array of linked note names (without aliases or headings).
 */
export function extractInternalLinks(content: string): string[] {
	const links: string[] = [];
	let match;

	while ((match = WIKILINK_REGEX.exec(content)) !== null) {
		const linkTarget = match[1].trim();
		if (linkTarget && !links.includes(linkTarget)) {
			links.push(linkTarget);
		}
	}

	// Reset regex state
	WIKILINK_REGEX.lastIndex = 0;

	return links;
}

/**
 * Resolve a link target to an actual file path.
 * Handles cases where the link doesn't include .md extension.
 */
export function resolveLinkToPath(app: App, linkTarget: string, sourcePath: string): string | null {
	// Use Obsidian's built-in link resolution
	const file = app.metadataCache.getFirstLinkpathDest(linkTarget, sourcePath);
	return file?.path ?? null;
}

/**
 * Get all resolved internal links from a note.
 * Returns array of file paths that the note links to.
 */
export function getResolvedLinks(app: App, file: TFile, content: string): string[] {
	const linkTargets = extractInternalLinks(content);
	const resolvedPaths: string[] = [];

	for (const target of linkTargets) {
		const resolvedPath = resolveLinkToPath(app, target, file.path);
		if (resolvedPath && resolvedPath !== file.path) {
			// Don't include self-links
			resolvedPaths.push(resolvedPath);
		}
	}

	return resolvedPaths;
}
