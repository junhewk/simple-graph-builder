/**
 * Splitting a note into its frontmatter and its body.
 *
 * Two things depend on this. The extractor must not see frontmatter -- tags and
 * aliases are not entities, and once the plugin starts writing a `related:`
 * property they would feed the model its own output. Change detection must not
 * see it either: the plugin edits frontmatter, so hashing the whole file would
 * mark every note it touches as changed and re-analyze it on the next save.
 *
 * Deliberately a plain parser rather than Obsidian's `getFrontMatterInfo`, so
 * hashing and chunking stay testable under the node stub. Every *write* still
 * goes through `processFrontMatter`, so nothing here can corrupt YAML.
 */

const BOM_CODE = 0xfeff;

export interface FrontmatterSplit {
	/** YAML between the delimiters, or null when the note has none. */
	yaml: string | null;
	/** Everything after the closing delimiter. The whole note when there is no frontmatter. */
	body: string;
	/** Offset into the original content where `body` starts. */
	bodyStart: number;
}

/**
 * Split off a leading `---` block. Frontmatter only counts when it opens on the
 * very first line, matching Obsidian.
 */
export function stripFrontmatter(content: string): FrontmatterSplit {
	const whole: FrontmatterSplit = { yaml: null, body: content, bodyStart: 0 };

	const bom = content.charCodeAt(0) === BOM_CODE ? 1 : 0;
	const rest = bom ? content.slice(bom) : content;

	const open = /^---[ \t]*\r?\n/.exec(rest);
	if (!open) return whole;

	// The first line that is nothing but `---` closes the block.
	const afterOpen = rest.slice(open[0].length);
	const close = /^---[ \t]*(\r?\n|$)/m.exec(afterOpen);
	if (!close) return whole;

	const bodyStart = bom + open[0].length + close.index + close[0].length;
	return {
		yaml: afterOpen.slice(0, close.index),
		body: content.slice(bodyStart),
		bodyStart,
	};
}
