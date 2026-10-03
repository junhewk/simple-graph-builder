/**
 * Deterministic graph-aware search and lookup, shared by the search modal and
 * the MCP server. No LLM calls: the agent on the other end of MCP is the LLM.
 *
 * Search is lexical first (BM25F over note text, name/alias/description
 * matching over entities), then spreads relevance through the graph with
 * Personalized PageRank so notes connected to what matched rank too. Every
 * result says why it matched.
 */
import { medLitPage } from '../import/node-props';
import { normalizeKey, normalizeUnicode } from '../types';
import { matchEntityName, calculateMatchScore } from './match';
import { personalizedPageRank } from './ppr';
import { GraphSnapshot, LabeledEdge, toRef } from './snapshot';
import { TextIndex } from './text-index';
import { normalizeText, queryWords } from './tokenize';
import { normalizeVaultPath } from './visibility';
import type {
	Connection,
	EntityDetails,
	EntityHit,
	EntityRef,
	GraphReader,
	IndexState,
	NeighborHit,
	NoteDetails,
	NotFound,
	Overview,
	PathStep,
	Relation,
	SearchOptions,
	SearchResponse,
	VaultSource,
} from './types';

/** Fields of a note and how much a hit in each counts. */
const NOTE_BOOSTS = { title: 3, aliases: 2, headings: 1.5, tags: 1.5, body: 1 };
/** Body text beyond this is not indexed; the head of a note carries its topic. */
export const MAX_INDEXED_BODY = 20_000;

const ENTITY_NAME_THRESHOLD = 0.5;
/** Looser: a "did you mean" list should survive a one-letter typo. */
const SUGGESTION_THRESHOLD = 0.35;
const SEED_LIMIT = 20;
const LEXICAL_WEIGHT = 0.6;
const GRAPH_WEIGHT = 0.4;
const MIN_NOTE_SCORE = 0.02;

export interface QueryEngineOptions {
	/** Yield to the UI while indexing. Tests pass a no-op. */
	yieldFn?: () => Promise<void>;
	yieldEvery?: number;
}

export class QueryEngine {
	private readonly notes = new TextIndex(NOTE_BOOSTS);
	private state: IndexState = 'idle';
	private indexed = 0;
	private total = 0;
	private building: Promise<void> | null = null;
	private readonly pending = new Set<string>();
	private work: Promise<void> = Promise.resolve();
	private vaultRevision = 0;
	private snapshot: GraphSnapshot | null = null;
	private snapshotKey = '';
	private readonly yieldFn: () => Promise<void>;
	private readonly yieldEvery: number;
	/** Visibility changed mid-build; rebuild once the current pass ends. */
	private restartAfterBuild = false;

	constructor(
		private readonly graph: GraphReader,
		private readonly source: VaultSource,
		options: QueryEngineOptions = {}
	) {
		this.yieldFn = options.yieldFn ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
		this.yieldEvery = options.yieldEvery ?? 25;
	}

	// --- index lifecycle ---

	indexStatus(): { state: IndexState; indexed: number; total: number } {
		return { state: this.state, indexed: this.indexed, total: this.total };
	}

	/** Build the note index once; later calls wait for the same build. */
	ensureIndexed(onProgress?: (indexed: number, total: number) => void): Promise<void> {
		if (this.state === 'ready') return Promise.resolve();
		if (!this.building) {
			this.building = this.build(onProgress).finally(() => {
				this.building = null;
			});
		}
		return this.building;
	}

	/** A note was created or edited. */
	onNoteChanged(path: string): void {
		this.vaultRevision++;
		if (this.state === 'building') {
			this.pending.add(path);
		} else if (this.state === 'ready') {
			this.enqueue(() => this.indexNote(path));
		}
	}

	onNoteDeleted(path: string): void {
		this.vaultRevision++;
		this.pending.delete(path);
		this.notes.delete(normalizeUnicode(path));
	}

	onNoteRenamed(oldPath: string, newPath: string): void {
		this.onNoteDeleted(oldPath);
		this.onNoteChanged(newPath);
	}

	/** Obsidian finished resolving links; the link graph may have changed. */
	onLinksChanged(): void {
		this.vaultRevision++;
	}

	/** Visibility rules changed (exclusion settings): start over. */
	invalidate(): void {
		this.vaultRevision++;
		this.notes.clear();
		this.pending.clear();
		this.indexed = 0;
		if (this.state === 'ready') this.state = 'idle';
		// A running build finishes against the old rules; restart it after.
		if (this.state === 'building') this.restartAfterBuild = true;
	}

	/** Wait for queued incremental updates (tests, and before answering MCP). */
	async settle(): Promise<void> {
		await this.work;
	}

	private async build(onProgress?: (indexed: number, total: number) => void): Promise<void> {
		this.state = 'building';
		const paths = this.source.listMarkdownPaths().filter(p => this.source.isVisible(p));
		this.total = paths.length;
		this.indexed = 0;
		for (const path of paths) {
			await this.indexNote(path);
			this.indexed++;
			if (this.indexed % this.yieldEvery === 0) {
				onProgress?.(this.indexed, this.total);
				await this.yieldFn();
			}
		}
		for (const path of this.pending) await this.indexNote(path);
		this.pending.clear();
		this.state = 'ready';
		onProgress?.(this.indexed, this.total);

		if (this.restartAfterBuild) {
			this.restartAfterBuild = false;
			this.invalidate();
			await this.build(onProgress);
		}
	}

	private async indexNote(path: string): Promise<void> {
		const key = normalizeUnicode(path);
		if (!this.source.isVisible(path)) {
			this.notes.delete(key);
			return;
		}
		const record = await this.source.readNote(path);
		if (!record) {
			this.notes.delete(key);
			return;
		}
		this.notes.set(key, {
			title: record.title,
			aliases: record.aliases,
			headings: record.headings,
			tags: record.tags,
			body: record.body.slice(0, MAX_INDEXED_BODY),
		});
	}

	private enqueue(task: () => Promise<void>): void {
		this.work = this.work.then(task).catch(e => console.error('[simple-graph-builder] index update failed', e));
	}

	private view(): GraphSnapshot {
		const key = `${this.graph.getRevision()}:${this.vaultRevision}`;
		if (!this.snapshot || key !== this.snapshotKey) {
			this.snapshot = new GraphSnapshot(this.graph, this.source);
			this.snapshotKey = key;
		}
		return this.snapshot;
	}

	// --- search ---

	async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
		const snap = this.view();
		const limit = clamp(options.limit ?? 10, 1, 50);
		const mode = options.mode ?? 'both';
		const words = queryWords(query);
		const tokens = words.flatMap(w => w.tokens);
		const prefix = options.pathPrefix ? folderPrefix(options.pathPrefix) : '';
		const typeFilter = options.types?.length ? new Set(options.types.map(t => t.toUpperCase())) : null;
		const response: SearchResponse = { query, notes: [], entities: [] };
		if (this.state !== 'ready') response.indexing = { indexed: this.indexed, total: this.total };

		const seedIndex = options.seed ? this.resolveSeed(snap, options.seed) : undefined;
		if (tokens.length === 0 && seedIndex === undefined) return response;

		// 1. Lexical note hits
		const lexical = this.notes.search(tokens, 100, p => snap.isNote(p)).filter(h => coversAWord(h.matched, words));
		const maxLex = lexical[0]?.score ?? 0;
		const lexNorm = new Map(lexical.map(h => [h.key, maxLex ? h.score / maxLex : 0]));

		// 2. Entity matches
		const matched = matchEntities(snap, query, words);

		// 3. Seeds: the two groups get equal say when both exist
		const seeds = new Map<number, number>();
		const noteSeeds = lexical.slice(0, SEED_LIMIT);
		const entitySeeds = [...matched.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, SEED_LIMIT);
		const noteSum = noteSeeds.reduce((s, h) => s + (lexNorm.get(h.key) ?? 0), 0);
		const entityWeights = entitySeeds.map(([id, m]) => [id, m.score / Math.log2(2 + snap.noteCount(id))] as const);
		const entitySum = entityWeights.reduce((s, [, w]) => s + w, 0);
		const groups = (noteSum > 0 ? 1 : 0) + (entitySum > 0 ? 1 : 0) + (seedIndex !== undefined ? 1 : 0);
		for (const h of noteSeeds) {
			addSeed(seeds, snap.nodeIndexOfNote(h.key), (lexNorm.get(h.key) ?? 0) / noteSum / groups);
		}
		for (const [id, w] of entityWeights) {
			addSeed(seeds, snap.entityIdx.get(id), w / entitySum / groups);
		}
		if (seedIndex !== undefined) addSeed(seeds, seedIndex, 1 / groups);

		// 4. Graph walk
		const rank = seeds.size ? personalizedPageRank(snap.csr, seeds) : new Float64Array(snap.csr.strength.length);
		const E = snap.entityCount;

		if (mode !== 'entities') {
			let maxNoteRank = 0;
			for (let i = E; i < rank.length; i++) maxNoteRank = Math.max(maxNoteRank, rank[i]);
			const candidates = new Set<string>(lexNorm.keys());
			for (const i of topIndices(rank, E, rank.length, 200)) candidates.add(snap.notePaths[i - E]);

			const scored: { path: string; score: number }[] = [];
			for (const path of candidates) {
				if (prefix && !path.startsWith(prefix)) continue;
				const idx = snap.nodeIndexOfNote(path);
				if (idx === undefined) continue;
				const graphScore = maxNoteRank ? rank[idx] / maxNoteRank : 0;
				const score = LEXICAL_WEIGHT * (lexNorm.get(path) ?? 0) + GRAPH_WEIGHT * graphScore;
				if (score >= MIN_NOTE_SCORE) scored.push({ path, score });
			}
			scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

			const matchedIds = new Set(matched.keys());
			for (const { path, score } of scored.slice(0, limit)) {
				response.notes.push({
					path,
					title: noteTitle(path),
					score: round(score),
					matchedWords: this.matchedWords(path, words),
					connections: connectionsFor(snap, path, matchedIds),
				});
			}

			if (options.snippets !== false) {
				await Promise.all(response.notes.map(async hit => {
					const content = await this.source.readContent(hit.path);
					if (content) hit.snippet = makeSnippet(content, words);
				}));
			}
		}

		if (mode !== 'notes') {
			let maxEntityRank = 0;
			for (let i = 0; i < E; i++) maxEntityRank = Math.max(maxEntityRank, rank[i]);
			const candidates = new Map<string, EntityHit['match']>();
			for (const [id, m] of matched) candidates.set(id, m.match);
			for (const i of topIndices(rank, 0, E, 100)) {
				const id = snap.entities[i].id;
				if (!candidates.has(id)) candidates.set(id, 'graph');
			}

			const hits: EntityHit[] = [];
			for (const [id, match] of candidates) {
				const i = snap.entityIdx.get(id)!;
				const node = snap.entities[i];
				if (typeFilter && !typeFilter.has(node.entityType)) continue;
				const graphScore = maxEntityRank ? rank[i] / maxEntityRank : 0;
				const score = LEXICAL_WEIGHT * (matched.get(id)?.score ?? 0) + GRAPH_WEIGHT * graphScore;
				if (score < MIN_NOTE_SCORE) continue;
				hits.push({
					...toRef(node),
					score: round(score),
					match,
					description: descriptionOf(node.properties.description),
					noteCount: snap.noteCount(id),
				});
			}
			hits.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
			response.entities = hits.slice(0, limit);
		}

		return response;
	}

	private resolveSeed(snap: GraphSnapshot, seed: string): number | undefined {
		const entity = snap.entityIdx.get(seed);
		if (entity !== undefined) return entity;
		return snap.nodeIndexOfNote(normalizeVaultPath(seed));
	}

	private matchedWords(path: string, words: QueryWord[]): string[] {
		const terms = this.notes.termsOf(path);
		if (!terms) return [];
		return words.filter(w => coversAWord(terms, [w])).map(w => w.word);
	}

	// --- lookups ---

	getEntity(ref: string): EntityDetails | NotFound {
		const snap = this.view();
		const resolved = resolveEntity(snap, ref);
		if ('error' in resolved) return resolved;
		const node = snap.entities[snap.entityIdx.get(resolved.id)!];

		const relations: Relation[] = snap.relationsOf(node.id).map(edge => toRelation(snap, edge));
		relations.sort((a, b) =>
			a.direction.localeCompare(b.direction) || a.verb.localeCompare(b.verb) || a.other.name.localeCompare(b.other.name));
		const sourceNotes = snap.notesByEntity.get(node.id) ?? [];
		const notePath = typeof node.properties.entityNotePath === 'string' ? node.properties.entityNotePath : medLitPage(node);
		const entityNote = notePath ? normalizeUnicode(notePath) : undefined;

		return {
			...toRef(node),
			description: descriptionOf(node.properties.description),
			aliases: Array.isArray(node.properties.aliases) ? node.properties.aliases.filter(a => typeof a === 'string') : [],
			entityNote: entityNote && snap.isNote(entityNote) ? entityNote : undefined,
			sourceNotes: sourceNotes.slice(0, 50),
			sourceNoteCount: sourceNotes.length,
			relations: relations.slice(0, 100),
			relationCount: relations.length,
		};
	}

	async getNote(ref: string, options: { includeContent?: boolean; maxChars?: number } = {}): Promise<NoteDetails | NotFound> {
		const snap = this.view();
		const resolved = this.resolveNote(snap, ref);
		if (typeof resolved !== 'string') return resolved;
		const path = resolved;

		const mentioned = snap.mentionsByNote.get(path) ?? [];
		const related = new Map<string, { score: number; shared: string[] }>();
		for (const id of mentioned) {
			const others = snap.notesByEntity.get(id) ?? [];
			const weight = 1 / Math.log2(2 + others.length);
			const name = snap.ref(id)!.name;
			for (const other of others) {
				if (other === path) continue;
				const entry = related.get(other) ?? { score: 0, shared: [] };
				entry.score += weight;
				if (entry.shared.length < 5) entry.shared.push(name);
				related.set(other, entry);
			}
		}

		const meta = this.source.noteMeta(path);
		const details: NoteDetails = {
			path,
			title: noteTitle(path),
			tags: meta.tags,
			aliases: meta.aliases,
			analyzed: mentioned.length > 0,
			entities: mentioned.map(id => snap.ref(id)!).sort((a, b) => a.name.localeCompare(b.name)),
			outgoingLinks: snap.outLinks.get(path) ?? [],
			backlinks: snap.backLinks.get(path) ?? [],
			related: [...related.entries()]
				.sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
				.slice(0, 10)
				.map(([p, r]) => ({ path: p, score: round(r.score), shared: r.shared })),
		};

		if (options.includeContent) {
			const maxChars = clamp(options.maxChars ?? 20_000, 200, 100_000);
			const content = (await this.source.readContent(path)) ?? '';
			details.content = content.slice(0, maxChars);
			details.truncated = content.length > maxChars;
		}
		return details;
	}

	neighbors(ref: string, options: {
		hops?: number;
		direction?: 'out' | 'in' | 'both';
		relation?: string;
		types?: string[];
		includeNotes?: boolean;
		limit?: number;
	} = {}): { entity: EntityRef; neighbors: NeighborHit[]; truncated: boolean; notes?: { path: string; title: string }[] } | NotFound {
		const snap = this.view();
		const resolved = resolveEntity(snap, ref);
		if ('error' in resolved) return resolved;

		const hops = clamp(options.hops ?? 1, 1, 3);
		const limit = clamp(options.limit ?? 50, 1, 200);
		const direction = options.direction ?? 'both';
		const verbFilter = options.relation ? normalizeKey(options.relation) : '';
		const typeFilter = options.types?.length ? new Set(options.types.map(t => t.toUpperCase())) : null;

		const start = snap.entityIdx.get(resolved.id)!;
		const parent = new Map<number, { from: number; edge: LabeledEdge }>();
		const depth = new Map<number, number>([[start, 0]]);
		let frontier = [start];
		for (let d = 1; d <= hops && frontier.length; d++) {
			const next: number[] = [];
			for (const node of frontier) {
				for (const edge of snap.adj[node]) {
					if (edge.to >= snap.entityCount || depth.has(edge.to)) continue;
					if (direction !== 'both' && edge.direction !== direction) continue;
					if (verbFilter && !normalizeKey(edge.verb).includes(verbFilter)) continue;
					depth.set(edge.to, d);
					parent.set(edge.to, { from: node, edge });
					next.push(edge.to);
				}
			}
			frontier = next;
		}

		const all: NeighborHit[] = [];
		for (const [index, d] of depth) {
			if (index === start) continue;
			const node = snap.entities[index];
			if (typeFilter && !typeFilter.has(node.entityType)) continue;
			all.push({ ...toRef(node), hops: d, path: tracePath(snap, parent, index) });
		}
		all.sort((a, b) => a.hops - b.hops || a.name.localeCompare(b.name));

		const result: { entity: EntityRef; neighbors: NeighborHit[]; truncated: boolean; notes?: { path: string; title: string }[] } = {
			entity: resolved,
			neighbors: all.slice(0, limit),
			truncated: all.length > limit,
		};
		if (options.includeNotes) {
			result.notes = (snap.notesByEntity.get(resolved.id) ?? []).slice(0, limit).map(path => ({ path, title: noteTitle(path) }));
		}
		return result;
	}

	findPath(fromRef: string, toRef_: string, options: { maxHops?: number; throughNotes?: boolean } = {}): { found: boolean; path: PathStep[] } | NotFound {
		const snap = this.view();
		const from = this.resolveNode(snap, fromRef);
		if (typeof from !== 'number') return from;
		const to = this.resolveNode(snap, toRef_);
		if (typeof to !== 'number') return to;
		const maxHops = clamp(options.maxHops ?? 4, 1, 6);

		const entityOnly = from < snap.entityCount && to < snap.entityCount;
		let path = entityOnly ? bfsPath(snap, from, to, maxHops, false) : null;
		if (!path && options.throughNotes !== false) path = bfsPath(snap, from, to, maxHops, true);
		return path ? { found: true, path } : { found: false, path: [] };
	}

	overview(): Overview {
		const snap = this.view();
		const entityTypes: Record<string, number> = {};
		for (const node of snap.entities) entityTypes[node.entityType] = (entityTypes[node.entityType] ?? 0) + 1;

		const verbs = new Map<string, number>();
		for (let i = 0; i < snap.entityCount; i++) {
			for (const edge of snap.adj[i]) {
				if (edge.direction === 'out' && edge.to < snap.entityCount) verbs.set(edge.verb, (verbs.get(edge.verb) ?? 0) + 1);
			}
		}

		const centrality = snap.centrality();
		const topEntities = topIndices(centrality, 0, snap.entityCount, 15).map(i => {
			const node = snap.entities[i];
			return {
				...toRef(node),
				score: round(centrality[i] * snap.csr.strength.length),
				degree: snap.relationsOf(node.id).length,
				noteCount: snap.noteCount(node.id),
			};
		});

		return {
			notes: { total: snap.notePaths.length, analyzed: snap.mentionsByNote.size },
			entities: snap.entityCount,
			relations: snap.relationCount,
			entityTypes,
			topEntities,
			topVerbs: [...verbs.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 15)
				.map(([verb, count]) => ({ verb, count })),
			index: this.indexStatus(),
		};
	}

	/** Entity types present in the visible graph, for filter dropdowns. */
	entityTypes(): string[] {
		return [...new Set(this.view().entities.map(n => n.entityType))].sort();
	}

	private resolveNote(snap: GraphSnapshot, ref: string): string | NotFound {
		const cleaned = normalizeVaultPath(ref.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0].trim());
		if (!cleaned) return { error: 'Empty note reference.' };
		for (const candidate of [cleaned, `${cleaned}.md`]) {
			if (snap.isNote(candidate)) return candidate;
		}

		const linked = this.source.resolveLinktext(cleaned);
		if (linked && snap.isNote(normalizeUnicode(linked))) return normalizeUnicode(linked);

		const wanted = normalizeKey(cleaned.replace(/\.md$/i, '').split('/').pop() ?? '');
		const byTitle = snap.notePaths.filter(p => normalizeKey(noteTitle(p)) === wanted);
		if (byTitle.length === 1) return byTitle[0];
		if (byTitle.length > 1) return { error: `"${ref}" matches several notes; pass the full path.`, candidates: byTitle.slice(0, 10) };

		const similar = snap.notePaths
			.map(p => ({ p, s: calculateMatchScore(wanted, noteTitle(p)) }))
			.filter(x => x.s >= SUGGESTION_THRESHOLD)
			.sort((a, b) => b.s - a.s)
			.slice(0, 5)
			.map(x => x.p);
		return { error: `No visible note matches "${ref}".`, candidates: similar };
	}

	/** An entity (id, name, alias) or a note (path, link text), as a node index. */
	private resolveNode(snap: GraphSnapshot, ref: string): number | NotFound {
		const entity = resolveEntity(snap, ref);
		if (!('error' in entity)) return snap.entityIdx.get(entity.id)!;
		const note = this.resolveNote(snap, ref);
		if (typeof note === 'string') return snap.nodeIndexOfNote(note)!;
		return { error: `Nothing in the graph matches "${ref}".`, candidates: entity.candidates };
	}
}

// --- helpers ---

function matchEntities(snap: GraphSnapshot, query: string, words: QueryWord[]): Map<string, { score: number; match: EntityHit['match'] }> {
	const out = new Map<string, { score: number; match: EntityHit['match'] }>();
	const trimmed = query.trim();
	if (!trimmed) return out;

	if (trimmed.length <= 80) {
		for (const node of snap.entities) {
			const aliases = Array.isArray(node.properties.aliases) ? node.properties.aliases.filter(a => typeof a === 'string') : [];
			const nameScore = calculateMatchScore(trimmed, node.properties.name);
			const best = matchEntityName(trimmed, node.properties.name, aliases);
			if (best >= ENTITY_NAME_THRESHOLD) {
				out.set(node.id, { score: best, match: nameScore >= best ? 'name' : 'alias' });
			}
		}
	}

	const tokens = words.flatMap(w => w.tokens);
	const described = snap.entityText.search(tokens, SEED_LIMIT).filter(h => coversAWord(h.matched, words));
	const max = described[0]?.score ?? 0;
	for (const hit of described) {
		if (out.has(hit.key) || !max) continue;
		out.set(hit.key, { score: 0.5 * (hit.score / max), match: 'description' });
	}
	return out;
}

type QueryWord = { word: string; tokens: string[] };

/**
 * A hit must match at least half the tokens of some query word. Korean words
 * are bigram-tokenized, so without this "머신러닝은" (machine learning) would
 * match "딥러닝" (deep learning) through the single shared bigram 러닝.
 */
function coversAWord(matched: ReadonlySet<string>, words: QueryWord[]): boolean {
	return words.some(w => {
		const hits = w.tokens.filter(t => matched.has(t)).length;
		return hits > 0 && hits >= Math.ceil(w.tokens.length / 2);
	});
}

function connectionsFor(snap: GraphSnapshot, path: string, matched: Set<string>): Connection[] {
	const mentioned = snap.mentionsByNote.get(path) ?? [];
	const direct: Connection[] = [];
	const oneHop: Connection[] = [];
	for (const id of mentioned) {
		if (matched.has(id)) {
			direct.push({ entity: snap.ref(id)! });
			continue;
		}
		if (oneHop.length >= 5) continue;
		for (const edge of snap.relationsOf(id)) {
			const other = snap.entities[edge.to];
			if (!matched.has(other.id)) continue;
			oneHop.push({ entity: snap.ref(id)!, via: { verb: edge.verb, direction: edge.direction, matched: toRef(other) } });
			break;
		}
	}
	return [...direct, ...oneHop].slice(0, 5);
}

function resolveEntity(snap: GraphSnapshot, ref: string): EntityRef | NotFound {
	const trimmed = ref.trim();
	if (!trimmed) return { error: 'Empty entity reference.' };
	const byId = snap.ref(trimmed);
	if (byId) return byId;

	for (const ids of [snap.idsByName(trimmed), snap.idsByAlias(trimmed)]) {
		if (ids.length === 1) return snap.ref(ids[0])!;
		if (ids.length > 1) {
			return { error: `"${ref}" names several entities; pass one of these ids.`, candidates: ids.map(id => snap.ref(id)!) };
		}
	}

	const candidates = snap.entities
		.map(node => ({ node, score: matchEntityName(trimmed, node.properties.name, Array.isArray(node.properties.aliases) ? node.properties.aliases : []) }))
		.filter(x => x.score >= SUGGESTION_THRESHOLD)
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map(x => toRef(x.node));
	return { error: `No visible entity is named "${ref}".`, candidates };
}

function toRelation(snap: GraphSnapshot, edge: LabeledEdge): Relation {
	const relation: Relation = {
		verb: edge.verb,
		direction: edge.direction,
		other: toRef(snap.entities[edge.to]),
	};
	if (edge.detail) relation.detail = edge.detail;
	if (edge.evidence) relation.evidence = edge.evidence;
	return relation;
}

function tracePath(snap: GraphSnapshot, parent: Map<number, { from: number; edge: LabeledEdge }>, end: number): PathStep[] {
	const steps: PathStep[] = [];
	let current: number | undefined = end;
	while (current !== undefined) {
		const link = parent.get(current);
		steps.push(stepFor(snap, current, link?.edge));
		current = link?.from;
	}
	return steps.reverse();
}

function stepFor(snap: GraphSnapshot, index: number, edge?: LabeledEdge): PathStep {
	const node = snap.describe(index);
	const step: PathStep = node.kind === 'entity'
		? { kind: 'entity', id: node.node.id, name: node.node.properties.name, type: node.node.entityType }
		: { kind: 'note', id: node.path, name: noteTitle(node.path) };
	if (edge) {
		step.via = { verb: edge.verb, direction: edge.direction };
		if (edge.evidence && edge.verb !== 'mentions' && edge.verb !== 'links to') step.via.evidence = edge.evidence;
	}
	return step;
}

function bfsPath(snap: GraphSnapshot, from: number, to: number, maxHops: number, throughNotes: boolean): PathStep[] | null {
	if (from === to) return [stepFor(snap, from)];
	const parent = new Map<number, { from: number; edge: LabeledEdge }>();
	const seen = new Set([from]);
	let frontier = [from];
	for (let d = 1; d <= maxHops && frontier.length; d++) {
		const next: number[] = [];
		for (const node of frontier) {
			for (const edge of snap.adj[node]) {
				if (seen.has(edge.to)) continue;
				if (!throughNotes && edge.to >= snap.entityCount) continue;
				seen.add(edge.to);
				parent.set(edge.to, { from: node, edge });
				if (edge.to === to) return tracePath(snap, parent, to);
				next.push(edge.to);
			}
		}
		frontier = next;
	}
	return null;
}

/** Indices in [start, end) with the highest positive values, best first. */
function topIndices(values: Float64Array, start: number, end: number, k: number): number[] {
	const picked: number[] = [];
	for (let i = start; i < end; i++) if (values[i] > 0) picked.push(i);
	picked.sort((a, b) => values[b] - values[a]);
	return picked.slice(0, k);
}

function addSeed(seeds: Map<number, number>, index: number | undefined, weight: number): void {
	if (index === undefined || !(weight > 0)) return;
	seeds.set(index, (seeds.get(index) ?? 0) + weight);
}

/** Excerpt around the first query word found, or the opening of the note. */
export function makeSnippet(content: string, words: { word: string; tokens: string[] }[], width = 240): string {
	const text = plainText(content);
	const lower = normalizeText(text);
	let pos = -1;
	for (const { word } of words) {
		const i = lower.indexOf(word);
		if (i >= 0 && (pos < 0 || i < pos)) pos = i;
	}
	if (pos < 0) {
		for (const token of words.flatMap(w => w.tokens)) {
			const i = lower.indexOf(token);
			if (i >= 0 && (pos < 0 || i < pos)) pos = i;
		}
	}
	const start = pos < 0 ? 0 : Math.max(0, pos - Math.floor(width / 3));
	const excerpt = text.slice(start, start + width).replace(/\s+/g, ' ').trim();
	return `${start > 0 ? '…' : ''}${excerpt}${start + width < text.length ? '…' : ''}`;
}

/** Markdown reduced to readable text, for previews. */
export function plainText(markdown: string): string {
	return markdown
		.normalize('NFC')
		.replace(/^---\n[\s\S]*?\n---\n?/, '')
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/!\[\[[^\]]*\]\]/g, ' ')
		.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
		.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\\[tn]/g, '\n')
		.replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
		.replace(/(\*\*|__|~~|==|`)/g, '')
		.replace(/%%[\s\S]*?%%/g, ' ');
}

export function noteTitle(path: string): string {
	return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

function folderPrefix(prefix: string): string {
	const p = normalizeVaultPath(prefix.trim()).replace(/^\/+|\/+$/g, '');
	return p ? `${p}/` : '';
}

function descriptionOf(value: unknown): string | undefined {
	return typeof value === 'string' && value ? value : undefined;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
