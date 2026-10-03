/**
 * Reading `.med-lit/sgb-export.json`, the graph med-lit writes for this plugin.
 *
 * med-lit keeps its data in SQLite and writes two views of it at the same
 * moment: the markdown pages and this file. Reading the file rather than the
 * database means the graph always matches the pages on disk, a crash never
 * hands over a half-written run (the file is replaced atomically, so the
 * previous export survives), and the plugin carries no SQLite engine.
 *
 * Format `med-lit-sgb/1`, documented in med-lit-mcp's docs/ontology.md. Minor
 * versions may add optional fields; a new major version is refused.
 */
import { EXTRACTION_ENTITY_TYPES, EntityType } from '../types';
import { ImportError } from './errors';
import type { MedLitKg } from './types';

export const EXPORT_PATH = '.med-lit/sgb-export.json';
const FORMAT_MAJOR = 'med-lit-sgb/1';

export interface SgbExport {
	project: { id: string; name: string; ontology: string };
	dataUpdatedAt: string;
	/** The bot update this export reflects; null without a bot. */
	botUpdate: number | null;
	kg: MedLitKg;
	/** Project-relative page paths by file key, as med-lit wrote them. */
	pages: Map<string, string>;
	/** Entities med-lit typed with something that is not an SGB type. */
	untyped: number;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const optStr = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : []);

function isExtractionType(value: unknown): value is EntityType {
	return typeof value === 'string' && (EXTRACTION_ENTITY_TYPES as readonly string[]).includes(value);
}

export function parseSgbExport(text: string): SgbExport {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new ImportError(`${EXPORT_PATH} is not valid JSON.`);
	}
	if (!isObject(raw)) throw new ImportError(`${EXPORT_PATH} is not a med-lit graph export.`);

	const format = str(raw.format);
	if (format !== FORMAT_MAJOR && !format.startsWith(`${FORMAT_MAJOR}.`)) {
		throw new ImportError(
			format.startsWith('med-lit-sgb/')
				? `This project's graph export is ${format}, newer than this version of Simple Graph Builder reads (${FORMAT_MAJOR}). Update the plugin.`
				: `${EXPORT_PATH} is not a med-lit graph export.`
		);
	}

	const project = isObject(raw.project) ? raw.project : {};
	const pages = new Map<string, string>();
	let untyped = 0;

	const entities = list(raw.entities).map(e => {
		const id = Number(e.id);
		const page = optStr(e.page);
		if (page) pages.set(`entity:${id}`, page);
		const sgbType = isExtractionType(e.sgb_type) ? e.sgb_type : 'CONCEPT';
		if (!isExtractionType(e.sgb_type)) untyped++;
		return {
			id,
			name: str(e.name),
			medLitType: str(e.type),
			sgbType,
			description: str(e.description),
			aliases: list(e.aliases).map(a => ({ alias: str(a.alias), source: str(a.source) })).filter(a => a.alias),
		};
	}).filter(e => Number.isFinite(e.id) && e.name);

	const articleUids: string[] = [];
	for (const a of list(raw.articles)) {
		const uid = str(a.uid);
		if (!uid) continue;
		articleUids.push(uid);
		const page = optStr(a.page);
		if (page) pages.set(`source:${uid}`, page);
	}

	const kg: MedLitKg = {
		entities,
		articleUids,
		mentions: list(raw.mentions).map(m => ({
			articleUid: str(m.article),
			entityId: Number(m.entity),
			role: optStr(m.role),
		})),
		relationships: list(raw.relationships).map(r => ({
			id: Number(r.id),
			source: Number(r.source),
			target: Number(r.target),
			verb: str(r.verb),
			detail: optStr(r.detail),
			evidence: list(r.evidence).map(e => ({ articleUid: str(e.article), quote: str(e.quote) })),
		})),
		merges: list(raw.merges).map(m => ({
			keptId: Number(m.kept),
			mergedId: Number(m.merged),
			mergedName: str(m.name),
		})),
	};

	return {
		project: { id: str(project.id), name: str(project.name), ontology: str(project.ontology) },
		dataUpdatedAt: str(raw.data_updated_at),
		botUpdate: typeof raw.bot_update === 'number' ? raw.bot_update : null,
		kg,
		pages,
		untyped,
	};
}
