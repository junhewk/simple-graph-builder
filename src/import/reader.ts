/**
 * Reading a med-lit project folder from outside the vault.
 *
 * The project lives wherever med-lit (or its bot) keeps it -- usually a synced
 * folder next to the vault, not inside it -- so this goes through Node's `fs`,
 * which Obsidian only offers on desktop. Kept behind an interface so the
 * snapshot reader can be tested against an in-memory folder.
 */
import { Platform } from 'obsidian';

export interface SnapshotReader {
	/** Every `.md` file, relative and `/`-separated. Dot-folders are skipped. */
	listMarkdown(): Promise<string[]>;
	readText(rel: string): Promise<string | null>;
}

interface NodeFs {
	promises: {
		readdir(path: string, options: { withFileTypes: true }): Promise<{ name: string; isDirectory(): boolean; isFile(): boolean }[]>;
		readFile(path: string, encoding: string): Promise<string>;
	};
}

interface NodePath {
	resolve(...parts: string[]): string;
	join(...parts: string[]): string;
	sep: string;
}

function loadNode(): { fs: NodeFs; path: NodePath } | null {
	if (!Platform.isDesktopApp) return null;
	try {
		const req = (window as unknown as { require?: (id: string) => unknown }).require;
		if (typeof req !== 'function') return null;
		return { fs: req('fs') as NodeFs, path: req('path') as NodePath };
	} catch {
		return null;
	}
}

/** True where a folder outside the vault can be read at all. */
export function canReadExternalFolders(): boolean {
	return loadNode() !== null;
}

/**
 * A reader over a folder on disk, or null on mobile.
 *
 * Paths handed in are relative to the root and may not climb out of it: the
 * listing and the snapshot reader only ever ask for files they found inside.
 */
export function createNodeFsReader(root: string): SnapshotReader | null {
	const node = loadNode();
	if (!node) return null;
	const { fs, path } = node;
	const base = path.resolve(root);

	const resolve = (rel: string): string => {
		const full = path.resolve(base, ...rel.split('/'));
		if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`Path escapes the project folder: ${rel}`);
		return full;
	};

	return {
		async listMarkdown() {
			const out: string[] = [];
			const walk = async (dir: string, prefix: string): Promise<void> => {
				for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
					if (entry.name.startsWith('.')) continue;
					const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
					if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
					else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(rel);
				}
			};
			await walk(base, '');
			return out.sort();
		},
		async readText(rel) {
			try { return await fs.promises.readFile(resolve(rel), 'utf8'); } catch { return null; }
		},
	};
}

