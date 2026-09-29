/**
 * VaultSource backed by the running Obsidian app.
 *
 * The engine keys notes by NFC path. macOS can hand Obsidian NFD file names,
 * so every lookup goes through an NFC -> real path map rather than
 * `getAbstractFileByPath` on the NFC string, which would miss those files.
 */
import { TFile } from 'obsidian';
import type { CachedMetadata } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { userExclusion } from '../analysis/exclusions';
import { stripFrontmatter } from '../sync/note-content';
import type { NoteRecord, VaultSource } from './types';
import { normalizeVaultPath, VisibilityCache } from './visibility';

export class ObsidianVaultSource implements VaultSource {
	private files: Map<string, TFile> | null = null;
	private readonly visibility: VisibilityCache;

	constructor(private readonly plugin: SimpleGraphBuilderPlugin) {
		this.visibility = new VisibilityCache({
			configDir: plugin.app.vault.configDir,
			isMarkdownFile: path => this.file(path) !== null,
			userExclusion: path => userExclusion(plugin, path).status,
		});
	}

	/** Vault contents or exclusion rules changed. */
	invalidate(): void {
		this.files = null;
		this.visibility.clear();
	}

	listMarkdownPaths(): string[] {
		return [...this.fileMap().keys()];
	}

	isVisible(path: string): boolean {
		return this.visibility.isVisible(path);
	}

	async readNote(path: string): Promise<NoteRecord | null> {
		const file = this.file(path);
		if (!file) return null;
		const content = await this.plugin.app.vault.cachedRead(file);
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		return {
			title: file.basename,
			aliases: frontmatterList(cache, 'aliases', 'alias'),
			tags: tagsOf(cache),
			headings: cache?.headings?.map(h => h.heading) ?? [],
			body: stripFrontmatter(content).body,
		};
	}

	async readContent(path: string): Promise<string | null> {
		const file = this.file(path);
		return file ? this.plugin.app.vault.cachedRead(file) : null;
	}

	resolvedLinks(): Record<string, Record<string, number>> {
		return this.plugin.app.metadataCache.resolvedLinks;
	}

	resolveLinktext(linktext: string, sourcePath = ''): string | null {
		return this.plugin.app.metadataCache.getFirstLinkpathDest(linktext, sourcePath)?.path ?? null;
	}

	noteMeta(path: string): { tags: string[]; aliases: string[] } {
		const file = this.file(path);
		const cache = file ? this.plugin.app.metadataCache.getFileCache(file) : null;
		return { tags: tagsOf(cache), aliases: frontmatterList(cache, 'aliases', 'alias') };
	}

	private file(path: string): TFile | null {
		return this.fileMap().get(normalizeVaultPath(path)) ?? null;
	}

	private fileMap(): Map<string, TFile> {
		if (!this.files) {
			this.files = new Map();
			for (const file of this.plugin.app.vault.getMarkdownFiles()) {
				if (file instanceof TFile) this.files.set(normalizeVaultPath(file.path), file);
			}
		}
		return this.files;
	}
}

function frontmatterList(cache: CachedMetadata | null | undefined, ...keys: string[]): string[] {
	const out: string[] = [];
	for (const key of keys) {
		const value: unknown = cache?.frontmatter?.[key];
		const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
		for (const item of items) {
			if (typeof item === 'string' && item.trim()) out.push(item.trim());
		}
	}
	return out;
}

/** Frontmatter and inline tags, without the leading '#'. */
function tagsOf(cache: CachedMetadata | null | undefined): string[] {
	const tags = new Set<string>();
	for (const tag of frontmatterList(cache, 'tags', 'tag')) tags.add(tag.replace(/^#/, ''));
	for (const tag of cache?.tags ?? []) tags.add(tag.tag.replace(/^#/, ''));
	return [...tags];
}
