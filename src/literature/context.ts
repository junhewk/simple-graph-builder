import type { OntologyEdge, OntologyNode } from '../types';
import { identifiers, object, str } from './results';
import type { ConceptSnapshot, LiteratureGraphContext, RouteStep, SourceNoteRef } from './types';

export interface WalkStep { nodeId: string; edgeId?: string }

/** Keep the captured traversal explainable without implying that selection jumps are edges. */
export function describeGraphRoute(context: LiteratureGraphContext): string {
	const names = new Map(context.nodes.map(node => [node.id, node.name]));
	return context.route.map((step, index) => {
		const via = step.via;
		const connector = !index ? '' : via?.kind === 'relationship'
			? via.direction === 'out' ? ` —${via.verb}→ ` : ` ←${via.verb}— `
			: ' · selected → ';
		return connector + (names.get(step.nodeId) ?? step.nodeId);
	}).join('');
}

/** Separate from the inspector's short breadcrumb list: preserve real traversals and jumps. */
export class ExplorationTrail {
	steps: WalkStep[] = [];
	truncated = false;

	visit(nodeId: string, edgeId?: string): void {
		const at = this.steps.findIndex(step => step.nodeId === nodeId);
		if (at >= 0) this.steps = this.steps.slice(0, at + 1);
		else this.steps.push({ nodeId, edgeId: this.steps.length ? edgeId : undefined });
		if (this.steps.length > 128) {
			this.steps.splice(1, 1);
			this.steps[1] = { nodeId: this.steps[1].nodeId };
			this.truncated = true;
		}
	}

	clear(): void { this.steps = []; this.truncated = false; }
}

interface ContextReader {
	getNodeById(id: string): OntologyNode | undefined;
	getEdgeById(id: string): OntologyEdge | undefined;
	getRevision(): number;
}

export interface CaptureOptions {
	steps: WalkStep[];
	selectedNodeId: string;
	originalSearch?: string;
	discovery: LiteratureGraphContext['discovery'];
	neighborhood?: LiteratureGraphContext['neighborhood'];
	distanceFromStart?: number;
	scope: LiteratureGraphContext['scope'];
	historyTruncated?: boolean;
}

/** Copies only scalar data. No graph mutations, extraction, source reads or network calls. */
export function captureGraphContext(
	graph: ContextReader,
	options: CaptureOptions,
	reference: (path: string) => SourceNoteRef,
): LiteratureGraphContext {
	const steps = options.steps.length ? options.steps : [{ nodeId: options.selectedNodeId }];
	const nodes: ConceptSnapshot[] = [];
	for (const id of new Set(steps.map(step => step.nodeId).concat(options.selectedNodeId))) {
		const node = graph.getNodeById(id);
		if (!node) continue;
		nodes.push({
			id, name: node.properties.name, type: node.entityType,
			aliases: Array.isArray(node.properties.aliases) ? node.properties.aliases.filter(a => typeof a === 'string').slice() : [],
			identifiers: identifiers(node.properties),
			sourceNotes: node.sourceNotes.map(reference).map(ref => ({ ...ref, identifiers: { ...ref.identifiers } })),
		});
	}
	if (!nodes.some(node => node.id === options.selectedNodeId)) throw new Error('The selected concept is no longer in the graph.');
	const route: RouteStep[] = steps.map((step, index) => {
		if (!index) return { nodeId: step.nodeId };
		const edge = step.edgeId ? graph.getEdgeById(step.edgeId) : undefined;
		const previous = steps[index - 1].nodeId;
		if (!edge || !((edge.source === previous && edge.target === step.nodeId) || (edge.target === previous && edge.source === step.nodeId))) {
			return { nodeId: step.nodeId, via: { kind: 'jump', evidence: [] } };
		}
		const evidence = relationshipEvidence(edge, reference);
		return { nodeId: step.nodeId, via: {
			kind: 'relationship', edgeId: edge.id, source: edge.source, target: edge.target,
			verb: edge.relationship, direction: edge.source === previous ? 'out' : 'in',
			detail: str(edge.properties.detail), evidence: evidence.map(ref => ({ ...ref, identifiers: { ...ref.identifiers } })),
		} };
	});
	return {
		version: 1, capturedAt: new Date().toISOString(), graphRevision: graph.getRevision(),
		originalSearch: options.originalSearch, startingNodeId: steps[0].nodeId, selectedNodeId: options.selectedNodeId,
		nodes, route, discovery: options.discovery, neighborhood: options.neighborhood ? { ...options.neighborhood } : undefined,
		distanceFromStart: options.distanceFromStart, scope: { ...options.scope }, historyTruncated: options.historyTruncated ?? false,
	};
}

export function relationshipEvidence(edge: OntologyEdge, reference: (path: string) => SourceNoteRef): SourceNoteRef[] {
	const evidence: SourceNoteRef[] = edge.sourceNote ? [reference(edge.sourceNote)] : [];
	for (const provenance of Object.values(object(edge.properties.medLit))) {
		const items = object(provenance).evidence;
		if (!Array.isArray(items)) continue;
		for (const raw of items) {
			const item = object(raw);
			const path = str(item.note);
			if (!path) continue;
			const ref = reference(path);
			const quote = str(item.quote);
			if (!evidence.some(e => e.path === ref.path && e.quote === quote)) evidence.push({ ...ref, quote });
		}
	}
	return evidence;
}
