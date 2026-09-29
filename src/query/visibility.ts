/**
 * Which vault paths the query engine may reveal: in search results, to agents
 * over MCP, or as evidence behind an entity.
 *
 * This is deliberately not the analysis-eligibility check. Entity notes the
 * plugin wrote are excluded from *analysis* (analysing them would feed the
 * graph back into itself) but are exactly what a search should find. The
 * user's own exclusions, on the other hand, apply to both: a folder kept away
 * from the LLM is also kept away from agents.
 */

export type UserExclusion = 'excluded' | 'ok' | 'unavailable';

export interface VisibilityContext {
	/** Vault config folder, usually `.obsidian`. */
	configDir: string;
	/** True only for an existing markdown file (a TFile), never a folder. */
	isMarkdownFile(path: string): boolean;
	userExclusion(path: string): UserExclusion;
}

export function normalizeVaultPath(path: string): string {
	return path.normalize('NFC').replace(/\\/g, '/');
}

export function isQueryVisiblePath(ctx: VisibilityContext, rawPath: string): boolean {
	if (typeof rawPath !== 'string' || !rawPath) return false;
	const path = normalizeVaultPath(rawPath);
	if (path.startsWith('/') || /^[a-z]:/i.test(path)) return false;

	const segments = path.split('/');
	if (segments.some(s => s === '' || s === '.' || s === '..')) return false;
	// .obsidian, .trash, .git and friends
	if (segments.some(s => s.startsWith('.'))) return false;
	const configDir = normalizeVaultPath(ctx.configDir).replace(/\/+$/, '');
	if (configDir && (path === configDir || path.startsWith(`${configDir}/`))) return false;

	if (!path.toLowerCase().endsWith('.md')) return false;
	if (!ctx.isMarkdownFile(path)) return false;

	// Fail closed: if the user asked to honour Obsidian's exclusions and they
	// cannot be read, hide rather than guess.
	return ctx.userExclusion(path) === 'ok';
}

/**
 * Memoized predicate. Vault events and exclusion-setting changes call
 * `clear()`; a stale "visible" answer for a deleted file is also caught by
 * `isMarkdownFile` on the next rebuild.
 */
export class VisibilityCache {
	private readonly memo = new Map<string, boolean>();

	constructor(private readonly ctx: VisibilityContext) {}

	isVisible(path: string): boolean {
		let visible = this.memo.get(path);
		if (visible === undefined) {
			visible = isQueryVisiblePath(this.ctx, path);
			this.memo.set(path, visible);
		}
		return visible;
	}

	clear(): void {
		this.memo.clear();
	}
}
