/**
 * Recognizing med-lit's pages and the provenance an import stores on graph
 * nodes and edges.
 *
 * Kept free of the plugin, so the analysis, sync and query layers can use it
 * without pulling in the importer.
 */
import type { OntologyEdge, OntologyNode } from '../types';
import type { MedLitEdgeProvenance, MedLitNodeProvenance } from './types';

export function nodeMedLit(node: OntologyNode): Record<string, MedLitNodeProvenance> {
	const value = node.properties.medLit;
	return value && typeof value === 'object' ? (value as Record<string, MedLitNodeProvenance>) : {};
}

export function edgeMedLit(edge: OntologyEdge): Record<string, MedLitEdgeProvenance> {
	const value = edge.properties.medLit;
	return value && typeof value === 'object' ? (value as Record<string, MedLitEdgeProvenance>) : {};
}

/** The entity's med-lit wiki page, if an import gave it one. */
export function medLitPage(node: OntologyNode): string | undefined {
	for (const provenance of Object.values(nodeMedLit(node))) {
		const page = provenance.pages?.find(p => typeof p === 'string' && p);
		if (page) return page;
	}
	return undefined;
}

/**
 * True when every note behind this entity came from an import. Such an entity
 * already has a page -- its med-lit wiki page -- and needs no entity note.
 */
export function isImportOnly(node: OntologyNode, isImported: (path: string) => boolean): boolean {
	return node.sourceNotes.length > 0 && node.sourceNotes.every(isImported);
}

/** True for a page med-lit generated (not one a user made protected). */
export function isMedLitGenerated(frontmatter: Record<string, unknown> | null | undefined): boolean {
	const generator = frontmatter?.generator;
	return typeof generator === 'string' && generator.startsWith('med-lit');
}
