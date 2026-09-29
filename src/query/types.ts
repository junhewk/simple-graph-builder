/**
 * Contracts between the query engine and the world, plus its result shapes.
 *
 * The engine never touches Obsidian directly: it reads the graph through
 * GraphReader and the vault through VaultSource. That keeps it runnable under
 * node in tests, and keeps every path it reveals behind one visibility check.
 */
import type { OntologyEdge, OntologyNode } from '../types';

export interface GraphReader {
	getRevision(): number;
	getAllNodes(): OntologyNode[];
	getAllEdges(): OntologyEdge[];
}

/** What the note index stores for one note. */
export interface NoteRecord {
	title: string;
	aliases: string[];
	tags: string[];
	headings: string[];
	body: string;
}

export interface VaultSource {
	/** All markdown paths, visible or not; the engine filters. */
	listMarkdownPaths(): string[];
	isVisible(path: string): boolean;
	/** Text and metadata for indexing, or null if the note is gone. */
	readNote(path: string): Promise<NoteRecord | null>;
	/** Raw note text, for snippets and get_note content. */
	readContent(path: string): Promise<string | null>;
	/** Obsidian's resolved link index: source path -> target path -> count. */
	resolvedLinks(): Record<string, Record<string, number>>;
	/** Resolve `[[link text]]` the way Obsidian would, from an optional source. */
	resolveLinktext(linktext: string, sourcePath?: string): string | null;
	/** Frontmatter tags/aliases for get_note. */
	noteMeta(path: string): { tags: string[]; aliases: string[] };
}

export type SearchMode = 'notes' | 'entities' | 'both';

export interface SearchOptions {
	limit?: number;
	mode?: SearchMode;
	/** Entity types to keep (entities only). */
	types?: string[];
	/** Only notes under this folder. */
	pathPrefix?: string;
	/** Seed the graph walk from this node (entity id or note path) as well. */
	seed?: string;
	/** Fetch snippets for the returned notes. */
	snippets?: boolean;
}

export interface EntityRef {
	id: string;
	name: string;
	type: string;
}

export interface Connection {
	/** The mentioned entity that connects the note to the query. */
	entity: EntityRef;
	/** Present when the connection is one relation away from a matched entity. */
	via?: { verb: string; direction: 'out' | 'in'; matched: EntityRef };
}

export interface NoteHit {
	path: string;
	title: string;
	score: number;
	/** Query words found in the note text. */
	matchedWords: string[];
	/** Entities that tie the note to the query, directly or one relation away. */
	connections: Connection[];
	snippet?: string;
}

export interface EntityHit extends EntityRef {
	score: number;
	/** Why it matched: 'name', 'alias', 'description', or 'graph' (reached by the walk). */
	match: 'name' | 'alias' | 'description' | 'graph';
	description?: string;
	noteCount: number;
}

export interface SearchResponse {
	query: string;
	notes: NoteHit[];
	entities: EntityHit[];
	/** Present while the note index is still being built. */
	indexing?: { indexed: number; total: number };
}

export interface Relation {
	verb: string;
	direction: 'out' | 'in';
	other: EntityRef;
	detail?: string;
	evidence?: string;
}

export interface EntityDetails extends EntityRef {
	description?: string;
	aliases: string[];
	entityNote?: string;
	sourceNotes: string[];
	sourceNoteCount: number;
	relations: Relation[];
	relationCount: number;
}

export interface NoteDetails {
	path: string;
	title: string;
	tags: string[];
	aliases: string[];
	analyzed: boolean;
	entities: EntityRef[];
	outgoingLinks: string[];
	backlinks: string[];
	/** Notes sharing entities with this one, rarest shared entities weighing most. */
	related: { path: string; score: number; shared: string[] }[];
	content?: string;
	truncated?: boolean;
}

export interface PathStep {
	kind: 'entity' | 'note';
	id: string;
	name: string;
	type?: string;
	/** How this step was reached from the previous one. */
	via?: { verb: string; direction: 'out' | 'in'; evidence?: string };
}

export interface NeighborHit extends EntityRef {
	hops: number;
	path: PathStep[];
}

export interface Overview {
	notes: { total: number; analyzed: number };
	entities: number;
	relations: number;
	entityTypes: Record<string, number>;
	topEntities: (EntityRef & { score: number; degree: number; noteCount: number })[];
	topVerbs: { verb: string; count: number }[];
	index: { state: IndexState; indexed: number; total: number };
}

export type IndexState = 'idle' | 'building' | 'ready';

/** A lookup that could not be resolved to exactly one thing. */
export interface NotFound {
	error: string;
	candidates?: EntityRef[] | string[];
}
