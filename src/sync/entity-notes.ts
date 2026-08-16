/**
 * Entity notes: one small markdown file per entity, owned by the plugin.
 *
 * This is what carries the plugin's entity resolution into Obsidian itself. The
 * embedding resolver decides that "ML", "머신러닝" and "기계학습" are one
 * concept; writing those as `aliases:` on a single note makes Obsidian agree --
 * its own link resolution, autocomplete, backlinks and graph view then behave
 * the way the knowledge graph does, for users who never open the plugin's view.
 *
 * Ownership contract, kept narrow on purpose: the plugin owns the `aliases`,
 * `entity-type` and `sgb-id` frontmatter keys, and the text between the managed
 * markers. Everything else in the file belongs to the user and survives every
 * regeneration.
 */
import { TFile, TFolder } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { OntologyNode, Settings, isNoteNode, normalizeKey } from '../types';
import { fileNameCandidates, entityNotePath, normalizeFolder } from './filenames';
import { MANAGED_START, MANAGED_END, RenderedRelationship, renderManagedBlock, replaceManagedBlock } from './render';

/** Frontmatter key holding the node id. Authoritative: filenames are lossy. */
export const ID_KEY = 'sgb-id';
const TYPE_KEY = 'entity-type';
const ALIASES_KEY = 'aliases';

/** Where a node's entity note lives, once one has been assigned. */
function storedPath(node: OntologyNode): string | null {
	const path = node.properties.entityNotePath;
	return typeof path === 'string' && path ? path : null;
}

/**
 * True for a note the plugin manages. Used to keep entity notes out of
 * analysis: they are plugin output, and extracting entities from them would
 * feed the graph its own summaries.
 */
export function isEntityNotePath(settings: Settings, path: string): boolean {
	if (!settings.enableEntityNotes) return false;
	const folder = normalizeFolder(settings.entityFolder);
	if (!folder) return false;
	return normalizeKey(path).startsWith(`${normalizeKey(folder)}/`);
}

/**
 * True for a file the plugin generated, judged by its own marker rather than by
 * where it sits or what the settings currently say.
 *
 * The path check above stops applying the moment the feature is switched off,
 * or if the folder setting changes -- and the files are still on disk. Without
 * this, turning the feature off would hand the extractor a folder full of the
 * plugin's own summaries to analyze.
 */
export function isManagedEntityNote(plugin: SimpleGraphBuilderPlugin, file: TFile): boolean {
	const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
	return typeof frontmatter?.[ID_KEY] === 'string';
}

function fileAt(plugin: SimpleGraphBuilderPlugin, path: string): TFile | null {
	const file = plugin.app.vault.getAbstractFileByPath(path);
	return file instanceof TFile ? file : null;
}

/**
 * A file's frontmatter, or null when Obsidian has not indexed it yet.
 *
 * The distinction matters: "no frontmatter" means the file is not ours, while
 * "not indexed yet" means we do not know. Treating the second as the first --
 * which happens while a vault is still indexing, or moments after the plugin
 * created the file -- makes `assignPath` disown a note it owns, create a
 * duplicate beside it, and repoint every link in the vault.
 */
function frontmatterOf(plugin: SimpleGraphBuilderPlugin, file: TFile): Record<string, unknown> | null {
	const cache = plugin.app.metadataCache.getFileCache(file);
	if (!cache) return null;
	return cache.frontmatter ?? {};
}

/** The file for a node, but only if it really is that node's entity note. */
export function getEntityNoteFile(plugin: SimpleGraphBuilderPlugin, node: OntologyNode): TFile | null {
	const path = storedPath(node);
	if (!path) return null;
	const file = fileAt(plugin, path);
	if (!file) return null;
	// Unknown counts as not-ours here: this gates deletion, so it must be certain.
	return frontmatterOf(plugin, file)?.[ID_KEY] === node.id ? file : null;
}

/** Create the entity folder, including any missing parents. */
async function ensureFolder(plugin: SimpleGraphBuilderPlugin, folder: string): Promise<void> {
	if (!folder) return;
	const segments = folder.split('/');
	let current = '';
	for (const segment of segments) {
		current = current ? `${current}/${segment}` : segment;
		const existing = plugin.app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) continue;
		if (existing) return; // a file sits where the folder should be; give up quietly
		try {
			await plugin.app.vault.createFolder(current);
		} catch {
			// Created concurrently, or already there. Either is fine.
		}
	}
}

/** Paths already spoken for, so two entities never claim one file. */
function claimedPaths(plugin: SimpleGraphBuilderPlugin): Map<string, string> {
	const claimed = new Map<string, string>();
	for (const node of plugin.graphCache.getAllNodes()) {
		const path = storedPath(node);
		if (path) claimed.set(normalizeKey(path), node.id);
	}
	return claimed;
}

/**
 * Decide which file belongs to a node, and remember it.
 *
 * A stored path is reused whenever the file is absent (we will create it) or
 * carries this node's id. Otherwise candidates are tried in order: the plain
 * name, then the name with its entity type, then the name with a hash of the
 * node id. A file that exists without this node's id is someone else's -- the
 * user's own note, or another entity -- and is never taken over.
 */
function assignPath(
	plugin: SimpleGraphBuilderPlugin,
	node: OntologyNode,
	claimed: Map<string, string>
): string {
	const existing = storedPath(node);
	if (existing) {
		const file = fileAt(plugin, existing);
		const frontmatter = file ? frontmatterOf(plugin, file) : null;
		// Keep the remembered path unless the file positively belongs to someone
		// else. An unindexed file says nothing, and must not cost us our note.
		if (!file || frontmatter === null || frontmatter[ID_KEY] === node.id) {
			claimed.set(normalizeKey(existing), node.id);
			return existing;
		}
	}

	const folder = plugin.settings.entityFolder;
	for (const candidate of fileNameCandidates(node)) {
		const path = entityNotePath(folder, candidate);
		const key = normalizeKey(path);

		const owner = claimed.get(key);
		if (owner && owner !== node.id) continue;

		// Claiming a new name is the opposite case: an existing file we cannot
		// vouch for is left alone rather than written into.
		const file = fileAt(plugin, path);
		if (file && frontmatterOf(plugin, file)?.[ID_KEY] !== node.id) continue;

		claimed.set(key, node.id);
		if (existing !== path) {
			node.properties.entityNotePath = path;
			plugin.graphCache.updateNode(node);
		}
		return path;
	}

	// All three candidates were taken. Fall back to the last one; the hash makes
	// this effectively unreachable.
	const fallback = entityNotePath(folder, fileNameCandidates(node)[2]);
	node.properties.entityNotePath = fallback;
	plugin.graphCache.updateNode(node);
	return fallback;
}

/** Outgoing entity-to-entity relationships, resolved to link targets. */
function relationshipsOf(plugin: SimpleGraphBuilderPlugin, node: OntologyNode): RenderedRelationship[] {
	const out: RenderedRelationship[] = [];
	const seen = new Set<string>();

	for (const edge of plugin.graphCache.getEdgesBySource(node.id)) {
		const target = plugin.graphCache.getNodeById(edge.target);
		if (!target || isNoteNode(target)) continue;

		const targetPath = storedPath(target);
		if (!targetPath) continue;

		const key = `${edge.relationship}|${target.id}`;
		if (seen.has(key)) continue;
		seen.add(key);

		out.push({ relationship: edge.relationship, targetName: target.properties.name, targetPath });
	}

	// Stable order, so regenerating a note that has not changed rewrites nothing.
	return out.sort((a, b) =>
		a.relationship.localeCompare(b.relationship) || a.targetName.localeCompare(b.targetName));
}

function aliasesOf(node: OntologyNode): string[] {
	const aliases = node.properties.aliases;
	return Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === 'string') : [];
}

function sameAliases(current: unknown, next: string[]): boolean {
	const existing = Array.isArray(current) ? current : current == null ? [] : [current];
	if (existing.length !== next.length) return false;
	return next.every((alias, i) => normalizeKey(String(existing[i])) === normalizeKey(alias));
}

export interface UpsertOptions {
	/**
	 * Called before each note is written, with 1-based progress. Return false to
	 * stop. Vault-wide runs use it to report progress, let Obsidian repaint, and
	 * honour Cancel -- without it a few thousand entities would write in one
	 * unbroken block and freeze the window.
	 */
	beforeEach?: (done: number, total: number, node: OntologyNode) => Promise<boolean>;
}

/**
 * Create or refresh the entity notes for these nodes.
 *
 * Two phases. First every node -- and every entity it points at -- gets a path,
 * so relationship links have somewhere to resolve to even when the target's own
 * note does not exist yet. Then each node's file is written. Targets outside the
 * batch are deliberately not created here: their notes appear when they are
 * analyzed or when the vault-wide write runs, and the link resolves then.
 *
 * Writes are skipped whenever the file already says the right thing, which is
 * what keeps re-analysis from touching the vault at all.
 *
 * The returned counts are disjoint: `created` is files that did not exist,
 * `updated` is existing files whose contents actually changed. Their sum is the
 * number of files touched.
 */
export async function upsertEntityNotes(
	plugin: SimpleGraphBuilderPlugin,
	nodes: OntologyNode[],
	options: UpsertOptions = {}
): Promise<{ created: number; updated: number }> {
	if (!plugin.settings.enableEntityNotes) return { created: 0, updated: 0 };

	const entities = nodes.filter(n => !isNoteNode(n));
	if (entities.length === 0) return { created: 0, updated: 0 };

	const claimed = claimedPaths(plugin);
	for (const node of entities) {
		assignPath(plugin, node, claimed);
		for (const edge of plugin.graphCache.getEdgesBySource(node.id)) {
			const target = plugin.graphCache.getNodeById(edge.target);
			if (target && !isNoteNode(target)) assignPath(plugin, target, claimed);
		}
	}

	await ensureFolder(plugin, normalizeFolder(plugin.settings.entityFolder));

	let created = 0;
	let updated = 0;

	for (const [index, node] of entities.entries()) {
		if (options.beforeEach && !(await options.beforeEach(index + 1, entities.length, node))) break;

		const path = storedPath(node);
		if (!path) continue;

		let file = fileAt(plugin, path);
		let isNew = false;
		if (!file) {
			try {
				file = await plugin.writeGuard.guard(path, () =>
					plugin.app.vault.create(path, `${MANAGED_START}\n${MANAGED_END}\n`)
				);
				created++;
				isNew = true;
			} catch (error) {
				console.error(`Simple Graph Builder: could not create ${path}`, error);
				continue;
			}
		}

		const touched = await writeEntityNote(plugin, file, node);
		// The two counts partition the files this touched. A note that was just
		// created is always written straight after, so counting it in both would
		// report twice the work actually done.
		if (touched && !isNew) updated++;
	}

	return { created, updated };
}

/** Write one entity note's owned regions. Returns true when anything changed. */
async function writeEntityNote(
	plugin: SimpleGraphBuilderPlugin,
	file: TFile,
	node: OntologyNode
): Promise<boolean> {
	let changed = false;

	const aliases = aliasesOf(node);
	// Unknown means "write it": a redundant write is cheap, a missing sgb-id is
	// what makes the plugin lose track of its own note.
	const current = frontmatterOf(plugin, file);
	const needsFrontmatter =
		!current ||
		current[ID_KEY] !== node.id ||
		current[TYPE_KEY] !== node.entityType ||
		!sameAliases(current[ALIASES_KEY], aliases);

	if (needsFrontmatter) {
		await plugin.writeGuard.guard(file.path, () =>
			plugin.app.fileManager.processFrontMatter(file, fm => {
				fm[ID_KEY] = node.id;
				fm[TYPE_KEY] = node.entityType;
				if (aliases.length > 0) fm[ALIASES_KEY] = aliases;
				else delete fm[ALIASES_KEY];
			})
		);
		changed = true;
	}

	const managed = renderManagedBlock(
		node,
		relationshipsOf(plugin, node),
		plugin.settings.writeRelationshipsSection
	);

	// The read decides *whether* to write; the write itself recomputes from the
	// data vault.process hands back. Writing a precomputed string would clobber
	// the frontmatter above if this read were even slightly stale.
	const before = await plugin.app.vault.cachedRead(file);
	if (replaceManagedBlock(before, managed) !== before) {
		await plugin.writeGuard.guard(file.path, () =>
			plugin.app.vault.process(file, current => replaceManagedBlock(current, managed))
		);
		changed = true;
	}

	return changed;
}

/**
 * Move an entity's note to the trash, once its entity is gone from the graph.
 *
 * Refuses anything that is not demonstrably the plugin's own note, so a user
 * file that happens to sit at the remembered path is never deleted.
 */
export async function deleteEntityNote(
	plugin: SimpleGraphBuilderPlugin,
	node: OntologyNode
): Promise<boolean> {
	const file = getEntityNoteFile(plugin, node);
	if (!file) return false;

	await plugin.writeGuard.guard(file.path, () => plugin.app.fileManager.trashFile(file));
	return true;
}
