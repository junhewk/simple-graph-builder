/**
 * Types for importing a med-lit-mcp project into the vault.
 *
 * med-lit-mcp (github.com/junhewk/med-lit-mcp) builds a medical-literature
 * wiki: article pages, entity pages and a knowledge graph in SQLite. Its
 * ontology is a refinement of this plugin's -- every med-lit type declares one
 * Simple Graph Builder parent type, exported on each entity page as `sgb_type`
 * -- so an import is a translation, not an interpretation: the conversion table
 * stays in med-lit, and the plugin only reads its result.
 */
import type { EntityType } from '../types';

/**
 * Stable identity of an imported file across snapshots, independent of path.
 *
 *   source:<uid>      an article page (`pmc:PMC…`, `pubmed:…`)
 *   entity:<id>       an entity (wiki) page; ids are stable within a project
 *   file:<relpath>    everything else: index.md, log.md, updates/*.md
 */
export type FileKey = string;

export interface MedLitProject {
	/** Stable across snapshots and paths; what makes a re-import an update. */
	id: string;
	name: string;
	ontology: string;
}

export interface MedLitAlias {
	alias: string;
	/** canonical | mention | acronym | merge | agent */
	source: string;
}

export interface MedLitEntity {
	id: number;
	name: string;
	/** med-lit's own type (CONDITION, INTERVENTION, ...). Kept as data. */
	medLitType: string;
	/** The Simple Graph Builder parent, as med-lit exported it. */
	sgbType: EntityType;
	description: string;
	aliases: MedLitAlias[];
}

export interface MedLitMention {
	articleUid: string;
	entityId: number;
	/** PICO/PCC role in that article, when it has one. */
	role: string | null;
}

export interface MedLitEvidence {
	articleUid: string;
	quote: string;
}

export interface MedLitRelationship {
	id: number;
	source: number;
	target: number;
	verb: string;
	detail: string | null;
	evidence: MedLitEvidence[];
}

export interface MedLitMerge {
	keptId: number;
	mergedId: number;
	mergedName: string;
}

/** The graph half of a project, normalized out of SQLite. */
export interface MedLitKg {
	entities: MedLitEntity[];
	articleUids: string[];
	mentions: MedLitMention[];
	relationships: MedLitRelationship[];
	merges: MedLitMerge[];
}

/** How far along a project's history a snapshot is. Compared, never shown raw. */
export interface SnapshotMarker {
	/** Highest bot update number in bot.json; 0 for a project without a bot. */
	lastUpdate: number;
	/** Latest timestamp of any article, entity or synthesis in the database. */
	dataUpdatedAt: string;
	articleCount: number;
}

export interface SnapshotFile {
	/** Path relative to the project root, `/`-separated. */
	rel: string;
	key: FileKey;
	/** Raw text with line endings normalized; links not yet rewritten. */
	content: string;
}

export interface MedLitSnapshot {
	project: MedLitProject;
	marker: SnapshotMarker;
	files: SnapshotFile[];
	kg: MedLitKg;
	warnings: string[];
}

export interface ManifestFile {
	/** Where the file lives in the vault now. Follows renames. */
	path: string;
	/** Where med-lit put it, relative to the project root. */
	rel: string;
	/** Hash of the content last written (or adopted): the merge base. */
	baseHash: string;
}

/** What the plugin remembers about one imported project. Lives in data.json. */
export interface ImportManifest {
	version: 1;
	projectId: string;
	name: string;
	/** Vault folder the project was imported into. Fixed after the first import. */
	vaultFolder: string;
	/** Last folder it was read from, offered again on update. Desktop path. */
	lastSourcePath: string;
	importedAt: number;
	marker: SnapshotMarker;
	files: Record<FileKey, ManifestFile>;
	/** med-lit entity id -> graph node id. Decided once, reused on update. */
	entityMap: Record<string, string>;
}

/** Per-project provenance stored on a graph node, under `properties.medLit[pid]`. */
export interface MedLitNodeProvenance {
	entityIds: number[];
	types: string[];
	/** The project's wiki page(s) for this entity, as vault paths. */
	pages: string[];
	/** The description this import filled in, if any; lets an update refresh it. */
	description?: string;
	/** Aliases this import added, so removing the import takes back only those. */
	aliases: string[];
}

/** Per-project evidence stored on a graph edge, under `properties.medLit[pid]`. */
export interface MedLitEdgeProvenance {
	relIds: number[];
	evidence: { note: string; quote: string }[];
}

export const MEDLIT_ONTOLOGY_MAJOR = 'med-lit/1';
