/**
 * Bringing the graph in line with one imported project.
 *
 * Not a diff. Each run works out the whole state the project should contribute
 * -- which nodes carry which of its pages as sources, which edges carry which
 * of its quotes -- and moves the graph to it. A second run with the same input
 * changes nothing, a run with `kg: null` takes the project back out, and none
 * of it depends on remembering what the previous run did: ownership is read off
 * the graph itself (a node lists the project's pages in `sourceNotes`, an edge
 * names one as its `sourceNote`) plus the per-project provenance kept under
 * `properties.medLit`.
 *
 * That is what lets it survive whatever happened in between: nodes merged by
 * hand, edges re-keyed by that merge, an update that renamed or dropped pages,
 * another project importing the same entities.
 *
 * Native provenance is never removed. A node the user's own notes also mention
 * keeps those notes; an edge first found in a user's note keeps that note as
 * its evidence and only gains the project's quotes alongside.
 */
import { generateEdgeId, generateNoteNodeId, normalizeName } from '../graph/merge';
import { isNoteNode, normalizeKey, OntologyEdge, OntologyNode } from '../types';
import type { GraphCache } from '../graph/cache';
import { edgeMedLit, nodeMedLit } from './node-props';
import type { FileKey, MedLitEdgeProvenance, MedLitEntity, MedLitKg, MedLitNodeProvenance } from './types';

export interface ReconcileInput {
	projectId: string;
	/** The project's graph, or null to remove the project from the graph. */
	kg: MedLitKg | null;
	entityMap: Record<string, string>;
	/** Vault path of an imported file that exists, by file key. */
	pathOf: (key: FileKey) => string | undefined;
	/** Every path the project owned before this run or owns after it. */
	ownedPaths: Iterable<string>;
}

export interface SuggestedMerge {
	/** The node med-lit kept. */
	keep: string;
	/** A node named after the entity med-lit merged into it. */
	other: string;
}

export interface ReconcileReport {
	nodesCreated: number;
	/** Nodes that existed before and now also carry the project. */
	nodesShared: number;
	nodesRemoved: number;
	edgesCreated: number;
	/** Existing edges that gained the project's evidence. */
	edgesShared: number;
	edgesRemoved: number;
	suggestedMerges: SuggestedMerge[];
}

interface DesiredNode {
	first: MedLitEntity;
	entityIds: number[];
	types: string[];
	pages: string[];
	notes: string[];
	description: string;
	aliases: string[];
}

interface DesiredEdge {
	source: string;
	target: string;
	verb: string;
	detail: string;
	sourceNote: string;
	provenance: MedLitEdgeProvenance;
}

function pushUnique<T>(list: T[], value: T): void {
	if (!list.includes(value)) list.push(value);
}

function desiredNodes(input: ReconcileInput, kg: MedLitKg): Map<string, DesiredNode> {
	const articlesByEntity = new Map<number, string[]>();
	for (const mention of kg.mentions) {
		const list = articlesByEntity.get(mention.entityId) ?? [];
		pushUnique(list, mention.articleUid);
		articlesByEntity.set(mention.entityId, list);
	}

	const desired = new Map<string, DesiredNode>();
	for (const entity of kg.entities) {
		const nodeId = input.entityMap[String(entity.id)];
		if (!nodeId) continue;

		let want = desired.get(nodeId);
		if (!want) {
			want = { first: entity, entityIds: [], types: [], pages: [], notes: [], description: '', aliases: [] };
			desired.set(nodeId, want);
		}
		want.entityIds.push(entity.id);
		pushUnique(want.types, entity.medLitType);
		want.description ||= entity.description;

		const page = input.pathOf(`entity:${entity.id}`);
		if (page) pushUnique(want.pages, page);
		for (const uid of articlesByEntity.get(entity.id) ?? []) {
			const note = input.pathOf(`source:${uid}`);
			if (note) pushUnique(want.notes, note);
		}

		pushUnique(want.aliases, normalizeName(entity.name));
		for (const { alias } of entity.aliases) if (alias.trim()) pushUnique(want.aliases, normalizeName(alias));
	}

	for (const [nodeId, want] of [...desired]) {
		// An entity no article page in the vault supports still has its wiki
		// page; that keeps it visible to search instead of silently vanishing.
		if (want.notes.length === 0) want.notes.push(...want.pages);
		if (want.notes.length === 0) desired.delete(nodeId);
		want.notes.sort();
	}
	return desired;
}

function desiredEdges(input: ReconcileInput, kg: MedLitKg, cache: GraphCache): Map<string, DesiredEdge> {
	const desired = new Map<string, DesiredEdge>();
	for (const rel of kg.relationships) {
		const source = input.entityMap[String(rel.source)];
		const target = input.entityMap[String(rel.target)];
		if (!source || !target || source === target) continue;
		if (!cache.getNodeById(source) || !cache.getNodeById(target)) continue;

		const verb = rel.verb.trim() || 'relates to';
		const id = generateEdgeId(source, target, verb);
		const evidence = rel.evidence
			.map(e => ({ note: input.pathOf(`source:${e.articleUid}`), quote: e.quote }))
			.filter((e): e is { note: string; quote: string } => !!e.note);

		let want = desired.get(id);
		if (!want) {
			const fallback = input.pathOf(`entity:${rel.source}`);
			want = {
				source,
				target,
				verb,
				detail: rel.detail?.trim() || evidence[0]?.quote || '',
				sourceNote: fallback ?? '',
				provenance: { relIds: [], evidence: [] },
			};
			desired.set(id, want);
		}
		want.provenance.relIds.push(rel.id);
		for (const item of evidence) {
			if (!want.provenance.evidence.some(e => e.note === item.note && e.quote === item.quote)) {
				want.provenance.evidence.push(item);
			}
		}
	}

	for (const [id, want] of [...desired]) {
		want.provenance.evidence.sort((a, b) => a.note.localeCompare(b.note) || a.quote.localeCompare(b.quote));
		want.sourceNote = want.provenance.evidence[0]?.note ?? want.sourceNote;
		if (!want.sourceNote) desired.delete(id);
	}
	return desired;
}

function withProvenance<T>(current: Record<string, T>, projectId: string, value: T | null): Record<string, T> | undefined {
	const next = { ...current };
	if (value) next[projectId] = value;
	else delete next[projectId];
	return Object.keys(next).length > 0 ? next : undefined;
}

export function reconcileProjectGraph(cache: GraphCache, input: ReconcileInput): ReconcileReport {
	const report: ReconcileReport = {
		nodesCreated: 0, nodesShared: 0, nodesRemoved: 0,
		edgesCreated: 0, edgesShared: 0, edgesRemoved: 0,
		suggestedMerges: [],
	};
	const pid = input.projectId;
	const ownedList = [...new Set(input.ownedPaths)];
	const owned = new Set(ownedList.map(normalizeKey));
	const isOwned = (path: string | undefined) => !!path && owned.has(normalizeKey(path));
	const now = Date.now();

	// The note layer for the project's pages is rebuilt from scratch afterwards;
	// dropping it first also keeps its edges out of everything below.
	for (const path of ownedList) cache.removeNode(generateNoteNodeId(path));

	const nodesWanted = input.kg ? desiredNodes(input, input.kg) : new Map<string, DesiredNode>();

	// --- nodes ---
	const touched = new Map<string, OntologyNode>();
	for (const node of cache.getAllNodes()) {
		if (isNoteNode(node)) continue;
		if (nodeMedLit(node)[pid] || node.sourceNotes.some(isOwned)) touched.set(node.id, node);
	}

	for (const [nodeId, want] of nodesWanted) {
		const existing = cache.getNodeById(nodeId);
		if (existing && isNoteNode(existing)) continue;
		if (!existing) {
			cache.addNode({
				id: nodeId,
				entityType: want.first.sgbType,
				properties: { name: normalizeName(want.first.name) },
				sourceNotes: [],
				createdAt: now,
				updatedAt: now,
			});
			report.nodesCreated++;
		} else if (!nodeMedLit(existing)[pid]) {
			report.nodesShared++;
		}
		touched.set(nodeId, cache.getNodeById(nodeId)!);
	}

	for (const node of touched.values()) {
		const want = nodesWanted.get(node.id) ?? null;
		const before = nodeMedLit(node)[pid];

		// Aliases: take back the ones this project added and no longer means,
		// then add the ones it does. addAliasToNode declines any alias another
		// node already holds, so only the ones it accepted are recorded.
		const wanted = new Set((want?.aliases ?? []).map(normalizeKey));
		wanted.delete(normalizeKey(node.properties.name));
		const recorded: string[] = [];
		for (const alias of before?.aliases ?? []) {
			if (wanted.has(normalizeKey(alias))) recorded.push(alias);
			else cache.removeAliasFromNode(node.id, alias);
		}
		for (const alias of want?.aliases ?? []) {
			if (!wanted.has(normalizeKey(alias))) continue;
			if (recorded.some(a => normalizeKey(a) === normalizeKey(alias))) continue;
			if (cache.addAliasToNode(node.id, alias)) recorded.push(alias);
		}

		cache.editNode(node, n => {
			const notes = n.sourceNotes.filter(p => !isOwned(p));
			if (want) for (const note of want.notes) pushUnique(notes, note);
			n.sourceNotes = notes;

			let filled: string | undefined;
			if (want?.description) {
				const current = n.properties.description;
				if (!current || current === before?.description) {
					n.properties.description = want.description;
					filled = want.description;
				}
			}

			const provenance: MedLitNodeProvenance | null = want
				? { entityIds: want.entityIds, types: want.types, pages: want.pages, description: filled, aliases: recorded }
				: null;
			const all = withProvenance(nodeMedLit(n), pid, provenance);
			if (all) n.properties.medLit = all;
			else delete n.properties.medLit;
		});
	}

	// --- edges ---
	const edgesWanted = input.kg ? desiredEdges(input, input.kg, cache) : new Map<string, DesiredEdge>();

	for (const edge of cache.getAllEdges()) {
		if (edgesWanted.has(edge.id)) continue;
		if (!edgeMedLit(edge)[pid] && !isOwned(edge.sourceNote)) continue;
		const source = cache.getNodeById(edge.source);
		if (source && isNoteNode(source)) continue;

		const others = withProvenance(edgeMedLit(edge), pid, null);
		if (!isOwned(edge.sourceNote)) {
			cache.editEdge(edge, e => {
				if (others) e.properties.medLit = others;
				else delete e.properties.medLit;
			});
			continue;
		}
		// The project was this edge's evidence. Another import may still vouch
		// for it; otherwise it goes.
		const fallback = Object.values(others ?? {}).flatMap(p => p.evidence ?? []).find(e => !isOwned(e.note));
		if (fallback) {
			cache.editEdge(edge, e => {
				e.sourceNote = fallback.note;
				e.properties.medLit = others;
			});
		} else {
			cache.removeEdge(edge.id);
			report.edgesRemoved++;
		}
	}

	for (const [id, want] of edgesWanted) {
		const existing = cache.getEdgeById(id);
		if (!existing) {
			const edge: OntologyEdge = {
				id,
				source: want.source,
				target: want.target,
				relationship: want.verb,
				properties: { detail: want.detail || undefined, medLit: { [pid]: want.provenance } },
				sourceNote: want.sourceNote,
				createdAt: now,
			};
			cache.addEdge(edge);
			report.edgesCreated++;
			continue;
		}

		const ours = !existing.sourceNote || isOwned(existing.sourceNote);
		if (!ours && !edgeMedLit(existing)[pid]) report.edgesShared++;
		cache.editEdge(existing, e => {
			e.properties.medLit = withProvenance(edgeMedLit(e), pid, want.provenance);
			if (ours) {
				e.sourceNote = want.sourceNote;
				if (want.detail) e.properties.detail = want.detail;
			}
		});
	}

	// --- nodes nothing supports any more ---
	for (const node of touched.values()) {
		const live = cache.getNodeById(node.id);
		if (!live || live.sourceNotes.length > 0) continue;
		cache.removeNode(live.id);
		cache.removeEmbedding(live.id);
		report.nodesRemoved++;
	}

	// med-lit merged these; if the graph still holds both, say so rather than
	// merging the person's nodes behind their back.
	for (const merge of input.kg?.merges ?? []) {
		const keep = input.entityMap[String(merge.keptId)];
		const other = cache.getNodeByName(merge.mergedName);
		if (keep && other && other.id !== keep && cache.getNodeById(keep) && !isNoteNode(other)) {
			report.suggestedMerges.push({ keep, other: other.id });
		}
	}

	return report;
}
