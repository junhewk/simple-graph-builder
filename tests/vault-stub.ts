/**
 * An in-memory vault, enough of one to exercise write-back.
 *
 * Not a *.test.ts, so the runner won't execute it directly.
 *
 * Frontmatter is modelled the way Obsidian actually presents it: writes go
 * through processFrontMatter and reads come back through metadataCache, never
 * by parsing YAML. That is the same contract the plugin codes against, so the
 * tests exercise the real path without needing a YAML implementation.
 */
import { TFile, TFolder } from 'obsidian';
import { GraphCache } from '../src/graph/cache';
import { WriteGuard } from '../src/sync/write-guard';
import { stripFrontmatter } from '../src/sync/note-content';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { Settings } from '../src/types';
import type SimpleGraphBuilderPlugin from '../src/main';

/** Enough YAML for what processFrontMatter is ever asked to write here. */
function toYaml(frontmatter: Record<string, unknown>): string {
	let out = '';
	for (const [key, value] of Object.entries(frontmatter)) {
		if (Array.isArray(value)) {
			out += `${key}:\n`;
			for (const item of value) out += `  - "${String(item)}"\n`;
		} else {
			out += `${key}: ${String(value)}\n`;
		}
	}
	return out;
}

export interface VaultStats {
	creates: number;
	bodyWrites: number;
	frontmatterWrites: number;
	trashed: string[];
}

function makeFile(path: string): TFile {
	const file = new TFile();
	file.path = path;
	file.name = path.slice(path.lastIndexOf('/') + 1);
	file.basename = file.name.replace(/\.md$/i, '');
	file.extension = 'md';
	return file;
}

export class FakeVault {
	files = new Map<string, TFile>();
	bodies = new Map<string, string>();
	frontmatter = new Map<string, Record<string, unknown>>();
	folders = new Set<string>();
	stats: VaultStats = { creates: 0, bodyWrites: 0, frontmatterWrites: 0, trashed: [] };

	/**
	 * Content as it looked before the last frontmatter write.
	 *
	 * With `serveStale` on, `cachedRead` hands this back once -- Obsidian's read
	 * cache is not guaranteed to have caught up right after a write. Code that
	 * writes a string it computed from that read destroys whatever the write it
	 * missed had put there.
	 */
	stale = new Map<string, string>();
	serveStale = false;

	seed(path: string, body: string, frontmatter?: Record<string, unknown>): TFile {
		const file = makeFile(path);
		this.files.set(path, file);
		this.bodies.set(path, body);
		if (frontmatter) {
			this.frontmatter.set(path, { ...frontmatter });
			this.serialize(path);
		}
		return file;
	}

	/**
	 * Fold the frontmatter object back into the file text, the way Obsidian does.
	 *
	 * Keeping the two in sync is the point: code that writes a precomputed string
	 * over the whole file after touching frontmatter loses it here, exactly as it
	 * would in a real vault.
	 */
	private serialize(path: string): void {
		const previous = this.bodies.get(path) ?? '';
		const fm = this.frontmatter.get(path);
		const body = stripFrontmatter(previous).body;
		this.bodies.set(path, fm && Object.keys(fm).length > 0 ? `---\n${toYaml(fm)}---\n${body}` : body);
		this.stale.set(path, previous);
	}

	/** The file text without its frontmatter block. */
	body(path: string): string {
		return stripFrontmatter(this.bodies.get(path) ?? '').body;
	}

	/** Called by the fake processFrontMatter once it has mutated the object. */
	writeFrontMatter(path: string): void {
		this.serialize(path);
	}

	getAbstractFileByPath(path: string) {
		if (this.files.has(path)) return this.files.get(path)!;
		if (this.folders.has(path)) {
			const folder = new TFolder();
			folder.path = path;
			return folder;
		}
		return null;
	}

	getMarkdownFiles(): TFile[] {
		return [...this.files.values()];
	}

	async createFolder(path: string): Promise<void> {
		if (this.folders.has(path)) throw new Error('Folder already exists');
		this.folders.add(path);
	}

	async create(path: string, content: string): Promise<TFile> {
		if (this.files.has(path)) throw new Error('File already exists');
		this.stats.creates++;
		return this.seed(path, content);
	}

	async cachedRead(file: TFile): Promise<string> {
		if (this.serveStale && this.stale.has(file.path)) {
			const previous = this.stale.get(file.path)!;
			this.stale.delete(file.path);
			return previous;
		}
		return this.bodies.get(file.path) ?? '';
	}

	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const next = fn(this.bodies.get(file.path) ?? '');
		this.bodies.set(file.path, next);
		this.stats.bodyWrites++;

		// A write that dropped the frontmatter block really did drop it; let the
		// metadata cache say so rather than hiding the damage.
		if (stripFrontmatter(next).yaml === null) this.frontmatter.delete(file.path);
		return next;
	}
}

/** A plugin surface with just what the sync layer touches. */
export function fakeSyncPlugin(settings: Partial<Settings> = {}, initialData?: Record<string, unknown>) {
	const vault = new FakeVault();
	const saved: unknown[] = [];
	// Round-tripped through JSON so callers see the same copying the real
	// loadData/saveData pair does -- suites that assert on stored hashes depend
	// on not sharing a reference with the plugin.
	let stored = initialData ? JSON.parse(JSON.stringify(initialData)) : null;

	const plugin = {
		settings: { ...DEFAULT_SETTINGS, enableEntityNotes: true, enableRelatedWriteback: true, ...settings },
		writeGuard: new WriteGuard(),
		loadData: async () => (stored ? JSON.parse(JSON.stringify(stored)) : null),
		saveData: async (data: unknown) => { stored = JSON.parse(JSON.stringify(data)); saved.push(data); },
		app: {
			vault,
			fileManager: {
				async processFrontMatter(file: TFile, fn: (fm: Record<string, unknown>) => void) {
					const fm = vault.frontmatter.get(file.path) ?? {};
					fn(fm);
					vault.frontmatter.set(file.path, fm);
					vault.writeFrontMatter(file.path);
					vault.stats.frontmatterWrites++;
				},
				async trashFile(file: TFile) {
					vault.stats.trashed.push(file.path);
					vault.files.delete(file.path);
					vault.bodies.delete(file.path);
					vault.frontmatter.delete(file.path);
				},
			},
			metadataCache: {
				getFileCache: (file: TFile) => ({ frontmatter: vault.frontmatter.get(file.path) }),
				getFirstLinkpathDest: () => null,
				resolvedLinks: {} as Record<string, Record<string, number>>,
			},
		},
	};

	// GraphCache only needs loadData/saveData; the same object serves both roles.
	const graphCache = new GraphCache(plugin as never);
	(plugin as unknown as { graphCache: GraphCache }).graphCache = graphCache;

	return { plugin: plugin as unknown as SimpleGraphBuilderPlugin, vault, graphCache, saved, latest: () => stored };
}
