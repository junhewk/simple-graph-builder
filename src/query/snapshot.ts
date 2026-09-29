/**
 * The visible slice of graph + vault that queries run against.
 *
 * Rebuilt lazily whenever the graph revision or the vault changes. Everything
 * in here has already passed the visibility check, so query code can hand any
 * of it to a caller without re-checking:
 *
 * - notes: every visible markdown file (not only analyzed ones)
 * - entities: non-NOTE nodes with at least one visible source note
 * - relations: entity-to-entity edges whose endpoints are visible and whose
 *   evidence note, if recorded, is visible too
 * - mentions (note -> entity, from sourceNotes) and wikilinks (from
 *   Obsidian's resolved link index), built here rather than taken from the
 *   cache's note layer, which only covers analyzed notes
 */
import { OntologyEdge, OntologyNode, isNoteLayerEdge, isNoteNode, normalizeKey, noteNodeIds, normalizeUnicode } from '../types';
import { buildCsr, Csr, globalPageRank } from './ppr';
import { TextIndex } from './text-index';
import type { EntityRef, GraphReader, VaultSource } from './types';

export const MENTION_WEIGHT = 1;
export const RELATION_WEIGHT = 1;
export const LINK_WEIGHT = 0.5;

export interface LabeledEdge {
	to: number;
	verb: string;
	/** Direction relative to the node whose list this is. */
	direction: 'out' | 'in';
	evidence?: string;
	detail?: string;
}

export class GraphSnapshot {
	readonly entities: OntologyNode[] = [];
	readonly entityIdx = new Map<string, number>();
	readonly notePaths: string[] = [];
	readonly noteIdx = new Map<string, number>();

	/** Labeled adjacency over the combined node space (entities first, then notes). */
	readonly adj: LabeledEdge[][] = [];
	readonly csr: Csr;

	readonly mentionsByNote = new Map<string, string[]>();
	readonly notesByEntity = new Map<string, string[]>();
	readonly outLinks = new Map<string, string[]>();
	readonly backLinks = new Map<string, string[]>();
	readonly relationCount: number;

	private readonly nameIndex = new Map<string, string[]>();
	private readonly aliasIndex = new Map<string, string[]>();
	readonly entityText = new TextIndex({ name: 3, aliases: 2, description: 1 });
	private pagerank: Float64Array | null = null;

	constructor(graph: GraphReader, source: VaultSource) {
		const allNodes = graph.getAllNodes();

		for (const path of source.listMarkdownPaths()) {
			const normalized = normalizeUnicode(path);
			if (this.noteIdx.has(normalized) || !source.isVisible(path)) continue;
			this.noteIdx.set(normalized, this.notePaths.length);
			this.notePaths.push(normalized);
		}

		for (const node of allNodes) {
			if (isNoteNode(node)) continue;
			const visibleNotes = [...new Set(node.sourceNotes.map(normalizeUnicode))].filter(p => this.noteIdx.has(p));
			if (visibleNotes.length === 0) continue;
			this.entityIdx.set(node.id, this.entities.length);
			this.entities.push(node);
			this.notesByEntity.set(node.id, visibleNotes);
			for (const path of visibleNotes) {
				const list = this.mentionsByNote.get(path);
				if (list) list.push(node.id);
				else this.mentionsByNote.set(path, [node.id]);
			}
			this.indexNames(node);
		}

		const E = this.entities.length;
		const total = E + this.notePaths.length;
		for (let i = 0; i < total; i++) this.adj.push([]);
		const weighted: [number, number, number][] = [];

		// entity -> entity relations
		const noteIds = noteNodeIds(allNodes);
		let relations = 0;
		for (const edge of graph.getAllEdges()) {
			if (isNoteLayerEdge(edge, noteIds)) continue;
			const a = this.entityIdx.get(edge.source);
			const b = this.entityIdx.get(edge.target);
			if (a === undefined || b === undefined || a === b) continue;
			const evidence = edge.sourceNote ? normalizeUnicode(edge.sourceNote) : undefined;
			if (evidence && !this.noteIdx.has(evidence)) continue;
			this.addLabeled(a, b, edge.relationship, evidence, edgeDetail(edge));
			weighted.push([a, b, RELATION_WEIGHT]);
			relations++;
		}
		this.relationCount = relations;

		// note -> entity mentions
		for (const [path, ids] of this.mentionsByNote) {
			const n = E + this.noteIdx.get(path)!;
			for (const id of ids) {
				const e = this.entityIdx.get(id)!;
				this.addLabeled(n, e, 'mentions', path);
				weighted.push([n, e, MENTION_WEIGHT]);
			}
		}

		// note -> note wikilinks
		const links = source.resolvedLinks();
		for (const [rawFrom, targets] of Object.entries(links)) {
			const from = normalizeUnicode(rawFrom);
			const fi = this.noteIdx.get(from);
			if (fi === undefined) continue;
			for (const rawTo of Object.keys(targets)) {
				const to = normalizeUnicode(rawTo);
				const ti = this.noteIdx.get(to);
				if (ti === undefined || ti === fi) continue;
				push(this.outLinks, from, to);
				push(this.backLinks, to, from);
				this.addLabeled(E + fi, E + ti, 'links to', from);
				weighted.push([E + fi, E + ti, LINK_WEIGHT]);
			}
		}

		this.csr = buildCsr(total, weighted);
	}

	get entityCount(): number {
		return this.entities.length;
	}

	isNote(path: string): boolean {
		return this.noteIdx.has(path);
	}

	nodeIndexOfNote(path: string): number | undefined {
		const i = this.noteIdx.get(path);
		return i === undefined ? undefined : this.entities.length + i;
	}

	/** Entity id or note path of a combined-space node index. */
	describe(index: number): { kind: 'entity'; node: OntologyNode } | { kind: 'note'; path: string } {
		return index < this.entities.length
			? { kind: 'entity', node: this.entities[index] }
			: { kind: 'note', path: this.notePaths[index - this.entities.length] };
	}

	ref(id: string): EntityRef | undefined {
		const i = this.entityIdx.get(id);
		if (i === undefined) return undefined;
		return toRef(this.entities[i]);
	}

	noteCount(id: string): number {
		return this.notesByEntity.get(id)?.length ?? 0;
	}

	idsByName(name: string): string[] {
		return this.nameIndex.get(normalizeKey(name)) ?? [];
	}

	idsByAlias(alias: string): string[] {
		return this.aliasIndex.get(normalizeKey(alias)) ?? [];
	}

	/** Entity-to-entity relations of one entity, both directions. */
	relationsOf(id: string): LabeledEdge[] {
		const i = this.entityIdx.get(id);
		if (i === undefined) return [];
		return this.adj[i].filter(edge => edge.to < this.entities.length);
	}

	/** Global PageRank per combined-space node, computed once per snapshot. */
	centrality(): Float64Array {
		if (!this.pagerank) this.pagerank = globalPageRank(this.csr);
		return this.pagerank;
	}

	private indexNames(node: OntologyNode): void {
		push(this.nameIndex, normalizeKey(node.properties.name), node.id);
		const aliases = Array.isArray(node.properties.aliases) ? node.properties.aliases.filter(isString) : [];
		for (const alias of aliases) push(this.aliasIndex, normalizeKey(alias), node.id);
		this.entityText.set(node.id, {
			name: node.properties.name,
			aliases,
			description: typeof node.properties.description === 'string' ? node.properties.description : '',
		});
	}

	private addLabeled(from: number, to: number, verb: string, evidence?: string, detail?: string): void {
		this.adj[from].push({ to, verb, direction: 'out', evidence, detail });
		this.adj[to].push({ to: from, verb, direction: 'in', evidence, detail });
	}
}

export function toRef(node: OntologyNode): EntityRef {
	return { id: node.id, name: node.properties.name, type: node.entityType };
}

function edgeDetail(edge: OntologyEdge): string | undefined {
	const detail = edge.properties?.detail;
	return typeof detail === 'string' && detail ? detail : undefined;
}

/** Callers never push a duplicate: resolvedLinks and node ids are unique. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
	const list = map.get(key);
	if (list) list.push(value);
	else map.set(key, [value]);
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}
