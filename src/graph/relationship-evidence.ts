import { edgeMedLit } from '../import/node-props';
import { normalizeKey, normalizeUnicode } from '../types';
import type { OntologyEdge, RelationshipClaim, RelationshipEvidence } from '../types';
import type { GraphCache } from './cache';

export function generateEdgeId(source: string, target: string, relationship: string): string {
	return `${source}->${target}:${normalizeKey(relationship)}`;
}

export function relationshipId(claim: RelationshipClaim): string {
	return generateEdgeId(claim.source, claim.target, claim.relationship);
}

/** A legacy edge keeps its recorded evidence until a note refreshes it. */
export function noteRelationshipEvidence(edge: OntologyEdge): readonly RelationshipEvidence[] {
	if (edge.noteEvidence) return edge.noteEvidence;
	if (!edge.sourceNote) return [];
	const note = normalizeUnicode(edge.sourceNote);
	const imports = Object.values(edgeMedLit(edge));
	if (imports.some(project => project.fallbackNote === note || project.evidence?.some(item => normalizeUnicode(item.note) === note))) return [];
	if (imports.length && imports.every(project => !project.fallbackNote && !project.evidence?.length)) return [];
	return [{ note, detail: edge.properties.detail }];
}

/** Keep the old single-source fields usable by graph displays and exports. */
export function setNoteRelationshipEvidence(edge: OntologyEdge, evidence: RelationshipEvidence[]): void {
	edge.noteEvidence = evidence;
	const primary = evidence[0];
	const imported = importedRelationshipEvidence(edge).next().value;
	edge.sourceNote = primary?.note ?? imported?.note;
	edge.properties.detail = primary ? primary.detail : imported?.quote;
}

function rememberLegacyImportSource(edge: OntologyEdge): void {
	if (!edge.sourceNote || edge.noteEvidence || noteRelationshipEvidence(edge).length) return;
	// Old imports with no article citation used a wiki page as their primary.
	const legacy = Object.values(edgeMedLit(edge)).find(project => !project.fallbackNote && !project.evidence?.length);
	if (legacy) legacy.fallbackNote = edge.sourceNote;
}

export function* importedRelationshipEvidence(edge: OntologyEdge): Generator<{ note: string; quote?: string }, undefined, undefined> {
	for (const project of Object.values(edgeMedLit(edge))) {
		yield* project.evidence ?? [];
		if (project.fallbackNote) yield { note: project.fallbackNote };
	}
	return undefined;
}

export function upsertRelationshipEvidence(
	cache: GraphCache, claim: RelationshipClaim, evidence: RelationshipEvidence,
	properties: OntologyEdge['properties'] = { detail: evidence.detail },
	legacyId?: string,
): boolean {
	const id = relationshipId(claim);
	const legacy = legacyId ? cache.getEdgeById(legacyId) : undefined;
	const existing = cache.getEdgeById(id) ?? (legacy && relationshipId(legacy) === id ? legacy : undefined);
	if (!existing) {
		cache.addEdge({ id, ...claim, properties,
			sourceNote: evidence.note, noteEvidence: [evidence], createdAt: Date.now() });
		return true;
	}
	const sources = [...noteRelationshipEvidence(existing)];
	const index = sources.findIndex(source => source.note === evidence.note && source.correctionId === evidence.correctionId);
	if (index < 0) sources.push(evidence);
	else if (sources[index].bodyHash === evidence.bodyHash && !evidence.checked) return false;
	else sources[index] = evidence;
	cache.editEdge(existing, edge => {
		rememberLegacyImportSource(edge);
		setNoteRelationshipEvidence(edge, sources);
	});
	return false;
}

export function removeRelationshipEvidence(
	cache: GraphCache, edge: OntologyEdge, remove: (evidence: RelationshipEvidence) => boolean,
): boolean {
	const evidence = noteRelationshipEvidence(edge);
	const kept = evidence.filter(source => !remove(source));
	if (kept.length === evidence.length) return false;
	if (!kept.length && !Object.keys(edgeMedLit(edge)).length) return cache.removeEdge(edge.id);
	cache.editEdge(edge, live => setNoteRelationshipEvidence(live, kept));
	return false;
}

/** Preserve both sources when an entity merge collapses two relationships. */
export function mergeRelationshipEvidence(target: OntologyEdge, source: OntologyEdge): void {
	rememberLegacyImportSource(target);
	rememberLegacyImportSource(source);
	const evidence = [...noteRelationshipEvidence(target)];
	for (const item of noteRelationshipEvidence(source)) {
		if (!evidence.some(other => other.note === item.note && other.correctionId === item.correctionId)) evidence.push(item);
	}
	const imports = { ...edgeMedLit(target) };
	for (const [id, incoming] of Object.entries(edgeMedLit(source))) {
		const current = imports[id];
		imports[id] = current ? {
			relIds: [...new Set([...current.relIds, ...incoming.relIds])],
			fallbackNote: current.fallbackNote ?? incoming.fallbackNote,
			evidence: [...current.evidence, ...incoming.evidence.filter(item => !current.evidence.some(
				old => old.note === item.note && old.quote === item.quote,
			))],
		} : incoming;
	}
	if (Object.keys(imports).length) target.properties.medLit = imports;
	if (evidence.length) setNoteRelationshipEvidence(target, evidence);
}
