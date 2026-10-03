/**
 * One read of a med-lit project folder: its identity, its pages and its graph.
 *
 * A snapshot is what the folder says right now. The plugin may see the same
 * project many times -- the bot adds a few articles a day -- and everything
 * downstream (the file merge, the graph reconcile) compares a snapshot with
 * what the last one left behind, so this does no interpretation beyond
 * normalizing what med-lit wrote.
 */
import { ImportError } from './errors';
import { EXPORT_PATH, parseSgbExport } from './export-json';
import type { SnapshotReader } from './reader';
import { isMedLitGenerated } from './node-props';
import {
	FileKey,
	MEDLIT_ONTOLOGY_MAJOR,
	MedLitProject,
	MedLitSnapshot,
	SnapshotFile,
	SnapshotMarker,
} from './types';

/** Line endings only: anything more would make "unchanged" files look edited. */
export function normalizeContent(text: string): string {
	return text.replace(/\r\n?/g, '\n');
}

/**
 * med-lit's front matter: `key: <JSON value>` per line. Bot reports write
 * plain scalars (`date: 2026-10-01`), which come back as strings.
 */
export function parseJsonFrontmatter(text: string): Record<string, unknown> | null {
	if (!text.startsWith('---\n')) return null;
	const end = text.indexOf('\n---', 4);
	if (end === -1) return null;

	const out: Record<string, unknown> = {};
	for (const line of text.slice(4, end).split('\n')) {
		const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
		if (!match) continue;
		const raw = match[2].trim();
		try {
			out[match[1]] = JSON.parse(raw);
		} catch {
			out[match[1]] = raw;
		}
	}
	return out;
}


export function fileKeyFor(rel: string, frontmatter: Record<string, unknown> | null): FileKey {
	if (frontmatter?.type === 'source' && typeof frontmatter.uid === 'string' && frontmatter.uid) {
		return `source:${frontmatter.uid}`;
	}
	if (frontmatter?.type === 'entity' && typeof frontmatter.entity_id === 'number') {
		return `entity:${frontmatter.entity_id}`;
	}
	return `file:${rel}`;
}

/** -1 when `a` is older than `b`, 1 when newer, 0 when they look the same. */
export function compareMarkers(a: SnapshotMarker, b: SnapshotMarker): number {
	if (a.dataUpdatedAt !== b.dataUpdatedAt && a.dataUpdatedAt && b.dataUpdatedAt) {
		return a.dataUpdatedAt < b.dataUpdatedAt ? -1 : 1;
	}
	if (a.lastUpdate !== b.lastUpdate) return a.lastUpdate < b.lastUpdate ? -1 : 1;
	if (a.articleCount !== b.articleCount) return a.articleCount < b.articleCount ? -1 : 1;
	return 0;
}

function isOntologySupported(ontology: string): boolean {
	return ontology === MEDLIT_ONTOLOGY_MAJOR || ontology.startsWith(`${MEDLIT_ONTOLOGY_MAJOR}.`);
}

async function readJson(reader: SnapshotReader, rel: string): Promise<Record<string, unknown> | null> {
	const raw = await reader.readText(rel);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		throw new ImportError(`${rel} is not valid JSON.`);
	}
}

/**
 * What bot.json says about the run behind this snapshot, when it is not a
 * finished one. The export is still consistent -- med-lit writes it with the
 * pages -- but it may not hold everything the person expects yet.
 */
function runWarning(bot: Record<string, unknown> | null, botUpdate: number | null): string | null {
	if (!bot) return null;
	const active = bot.active;
	if (active && typeof active === 'object') {
		const update = (active as Record<string, unknown>).update;
		return `A med-lit run${typeof update === 'number' ? ` (update ${update})` : ''} is still in progress; this imports its state so far. Update again once it finishes.`;
	}
	const history = Array.isArray(bot.history) ? (bot.history as Record<string, unknown>[]) : [];
	const last = history[history.length - 1];
	if (!last || last.outcome === 'finished' || typeof last.outcome !== 'string') return null;
	const update = typeof last.update === 'number' ? last.update : null;
	return `The last med-lit run${update !== null ? ` (update ${update})` : ''} did not finish` +
		(botUpdate !== null ? `; this imports the state exported with update ${botUpdate}.` : '.') +
		' The next run picks up its work.';
}

export async function readMedLitSnapshot(reader: SnapshotReader): Promise<MedLitSnapshot> {
	const warnings: string[] = [];

	const projectJson = await readJson(reader, '.med-lit/project.json');
	if (!projectJson) {
		throw new ImportError('This folder is not a med-lit project (no .med-lit/project.json).');
	}
	const project: MedLitProject = {
		id: typeof projectJson.id === 'string' ? projectJson.id : '',
		name: typeof projectJson.name === 'string' && projectJson.name.trim() ? projectJson.name.trim() : 'med-lit project',
		ontology: typeof projectJson.ontology === 'string' ? projectJson.ontology : '',
	};
	if (!project.id) throw new ImportError('.med-lit/project.json has no project id.');

	const exportText = await reader.readText(EXPORT_PATH);
	if (exportText === null) {
		throw new ImportError(
			'This project has no graph export yet (.med-lit/sgb-export.json). It needs med-lit-mcp 0.1.6 or later: ' +
			'run its export_wiki tool once, or wait for the next bot run.'
		);
	}
	const exported = parseSgbExport(exportText);
	if (exported.project.id && exported.project.id !== project.id) {
		throw new ImportError('The graph export belongs to a different med-lit project than this folder. Run med-lit\'s export again.');
	}
	const ontology = exported.project.ontology || project.ontology;
	if (!isOntologySupported(ontology)) {
		throw new ImportError(
			`This project uses ontology "${ontology || 'unknown'}"; this version of Simple Graph Builder reads ${MEDLIT_ONTOLOGY_MAJOR}.`
		);
	}
	if (exported.untyped > 0) warnings.push(`${exported.untyped} entities have no valid sgb_type; typed as CONCEPT.`);

	const bot = await readJson(reader, '.med-lit/bot.json').catch(() => null);
	const run = runWarning(bot, exported.botUpdate);
	if (run) warnings.push(run);
	const history = bot && Array.isArray(bot.history) ? (bot.history as Record<string, unknown>[]) : [];
	const lastUpdate = exported.botUpdate ??
		history.reduce((max, entry) => Math.max(max, typeof entry.update === 'number' ? entry.update : 0), 0);

	// The export names each entity's and article's page. Anything else med-lit
	// generated (index, log, bot reports) is keyed by its path.
	const keyByPage = new Map<string, FileKey>();
	for (const [key, rel] of exported.pages) keyByPage.set(rel, key);

	const files: SnapshotFile[] = [];
	const seen = new Map<FileKey, string>();
	let skipped = 0;
	let stale = 0;

	for (const rel of await reader.listMarkdown()) {
		const text = await reader.readText(rel);
		if (text === null) continue;
		const content = normalizeContent(text);
		const frontmatter = parseJsonFrontmatter(content);
		// A page whose generator line was removed is one the user took over in
		// med-lit's own terms.
		if (!isMedLitGenerated(frontmatter)) {
			skipped++;
			continue;
		}

		const key = keyByPage.get(rel) ?? fileKeyFor(rel, frontmatter);
		// A page for an entity or article the export does not have is a
		// leftover med-lit had not cleaned up yet; it is not part of the project.
		if ((key.startsWith('entity:') || key.startsWith('source:')) && exported.pages.get(key) !== rel) {
			stale++;
			continue;
		}
		const previous = seen.get(key);
		if (previous) {
			warnings.push(`Two pages claim ${key}: "${previous}" and "${rel}". Kept the first.`);
			continue;
		}
		seen.set(key, rel);
		files.push({ rel, key, content });
	}
	if (skipped > 0) warnings.push(`${skipped} page(s) without a med-lit generator line were left out.`);
	if (stale > 0) warnings.push(`${stale} leftover page(s) for entities or articles no longer in the graph were left out.`);

	const missing = [...exported.pages.keys()].filter(key => !seen.has(key)).length;
	const unpaged = exported.kg.entities.length + exported.kg.articleUids.length - exported.pages.size;
	if (missing + unpaged > 0) {
		warnings.push(`${missing + unpaged} entities or articles have no page in this folder; they join the graph without one.`);
	}

	const marker: SnapshotMarker = {
		lastUpdate,
		dataUpdatedAt: exported.dataUpdatedAt,
		articleCount: exported.kg.articleUids.length,
	};

	return { project, marker, files, kg: exported.kg, warnings };
}
