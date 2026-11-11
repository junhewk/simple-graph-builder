/** Read-only literature retrieval contracts, independent of extraction and MCP. */
export const LITERATURE_SOURCES = ['pubmed', 'openalex'] as const;
export type LiteratureSource = typeof LITERATURE_SOURCES[number];
export const SOURCE_NAMES: Record<LiteratureSource, string> = { pubmed: 'PubMed', openalex: 'OpenAlex' };

export interface PublicationIds {
	doi?: string;
	pmid?: string;
	pmcid?: string;
	openalex?: string;
}

export interface SourceNoteRef {
	path: string;
	quote?: string;
	identifiers: PublicationIds;
}

export interface ConceptSnapshot {
	id: string;
	name: string;
	type: string;
	aliases: string[];
	identifiers: PublicationIds;
	sourceNotes: SourceNoteRef[];
}

export interface RouteStep {
	nodeId: string;
	/** Absent on the first step; a jump is a selection, not a relationship. */
	via?: {
		kind: 'relationship' | 'jump';
		edgeId?: string;
		source?: string;
		target?: string;
		verb?: string;
		direction?: 'out' | 'in';
		detail?: string;
		evidence: SourceNoteRef[];
	};
}

export interface LiteratureGraphContext {
	version: 1;
	capturedAt: string;
	graphRevision: number;
	originalSearch?: string;
	researchQuestion?: string;
	startingNodeId: string;
	selectedNodeId: string;
	nodes: ConceptSnapshot[];
	route: RouteStep[];
	discovery: 'selection' | 'neighborhood' | 'propagation' | 'shortest-path';
	neighborhood?: { anchorNodeId: string; hops: 1 | 2 };
	distanceFromStart?: number;
	scope: { includesNoteNodes: boolean; filtered: boolean; truncated: boolean };
	historyTruncated: boolean;
}

export interface ConceptGroup {
	conceptId?: string;
	expressions: string[];
}

export interface LiteratureQueryDraft {
	groups: ConceptGroup[];
	sources: LiteratureSource[];
	from: string;
	to: string;
	pageSize: number;
	limit: number;
	nativeOverrides: Partial<Record<LiteratureSource, string>>;
}

export interface CompiledSearch {
	source: LiteratureSource;
	query: string;
	from: string;
	to: string;
	pageSize: number;
	limit: number;
	sort: 'relevance';
	scope: 'title/abstract' | 'provider-native query';
}

export interface LiteratureCredentials {
	pubmed?: string;
	openalex?: string;
	contactEmail: string;
}

export type PublicationAbstract =
	| { state: 'available'; sections: { label?: string; text: string }[] }
	| { state: 'missing' | 'empty' | 'error'; message?: string };

export interface AccessLink {
	kind: 'open-access' | 'publisher' | 'record';
	url: string;
	label: string;
}

export interface PublicationRecord {
	source: LiteratureSource;
	sourceRecordId: string;
	retrievedAt: string;
	sourceRank: number;
	title?: string;
	authors?: string[];
	authorsTruncated?: boolean;
	year?: number;
	venue?: string;
	publicationTypes?: string[];
	abstract: PublicationAbstract;
	identifiers: PublicationIds;
	accessLinks: AccessLink[];
}

export type PageToken = { kind: 'pubmed'; ids: string[]; offset: number } | { kind: 'openalex'; page: number };

export interface LiteraturePage {
	records: PublicationRecord[];
	total: number;
	next?: PageToken;
	translation?: string;
	warnings: string[];
}

export interface LiteratureAdapter {
	search(spec: CompiledSearch, credentials: LiteratureCredentials, active: () => boolean, next?: PageToken): Promise<LiteraturePage>;
}

export interface SourceSearchState {
	spec: CompiledSearch;
	status: 'loading' | 'success' | 'empty' | 'error' | 'stopped';
	records: PublicationRecord[];
	total?: number;
	next?: PageToken;
	translation?: string;
	warnings: string[];
	error?: string;
	cached?: boolean;
	fetchedAt?: string;
}

export interface LiteratureSearchState {
	startedAt: string;
	sources: Partial<Record<LiteratureSource, SourceSearchState>>;
}
