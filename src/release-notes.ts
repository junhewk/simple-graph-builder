/**
 * "What's new" after an update: which CHANGELOG.md sections to show, if any.
 *
 * The changelog is bundled into main.js at build time, so the notes are the
 * changelog itself and nothing is fetched. Only feature releases (a new minor
 * or major version) are announced; a fix release is recorded silently.
 */

export interface ReleaseSection {
	version: string;
	/** The heading as written, e.g. "0.9.0: build the graph with your agent". */
	heading: string;
	body: string;
}

const REPO_FILES = 'https://github.com/junhewk/simple-graph-builder/blob/master/';
export const CHANGELOG_URL = `${REPO_FILES}CHANGELOG.md`;

/** At most this many releases at once, for someone who skipped several. */
const MAX_SECTIONS = 3;

/** Released sections, newest first as written. "Unreleased" is skipped. */
export function parseChangelog(text: string): ReleaseSection[] {
	const sections: ReleaseSection[] = [];
	let current: ReleaseSection | null = null;
	const lines: string[] = [];
	const close = () => {
		if (current) sections.push({ ...current, body: lines.join('\n').trim() });
		lines.length = 0;
	};
	for (const line of text.split('\n')) {
		const heading = /^## (.+)$/.exec(line);
		if (heading) {
			close();
			const version = /^(\d+\.\d+\.\d+)\b/.exec(heading[1].trim());
			current = version ? { version: version[1], heading: heading[1].trim(), body: '' } : null;
			continue;
		}
		if (current) lines.push(line);
	}
	close();
	return sections;
}

/**
 * The sections to show someone moving from `lastSeen` to `current`.
 *
 * `lastSeen` is empty for an install that predates this check: it gets the
 * current feature release's sections, not the whole history.
 */
export function releaseNotesToShow(sections: ReleaseSection[], lastSeen: string, current: string): ReleaseSection[] {
	if (lastSeen && (compareVersions(current, lastSeen) <= 0 || sameFeatureRelease(lastSeen, current))) return [];
	return sections
		.filter(s => compareVersions(s.version, current) <= 0)
		.filter(s => (lastSeen ? compareVersions(s.version, lastSeen) > 0 : sameFeatureRelease(s.version, current)))
		.slice(0, MAX_SECTIONS);
}

/**
 * Relative links point into the repository; inside Obsidian they would be
 * read as links to notes in the vault.
 */
export function withAbsoluteLinks(markdown: string): string {
	return markdown.replace(/\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi, (_, path: string) => `](${REPO_FILES}${path.replace(/^\.?\//, '')})`);
}

export function compareVersions(a: string, b: string): number {
	const x = parts(a);
	const y = parts(b);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

function sameFeatureRelease(a: string, b: string): boolean {
	const x = parts(a);
	const y = parts(b);
	return x[0] === y[0] && x[1] === y[1];
}

function parts(version: string): number[] {
	const numbers = version.split('.').map(n => parseInt(n, 10));
	return [0, 1, 2].map(i => (Number.isFinite(numbers[i]) ? numbers[i] : 0));
}
