/**
 * Matching a project's entities to the graph's.
 *
 * This is where an imported graph stops being a separate island: "Large
 * language models (LLMs)" from med-lit and "LLM" from the user's own notes
 * should be one node. The plugin's EntityResolver already does this for
 * extraction -- exact name, alias, then embeddings with optional LLM
 * verification -- and an imported entity goes through it unchanged, typed with
 * med-lit's own Simple Graph Builder parent so embedding matches (which stay
 * within a type) compare like with like.
 *
 * med-lit also knows aliases the resolver never sees: acronyms it found
 * defined in the text, names it merged away. Those get a second chance below.
 *
 * A decision is made once per entity and stored in the manifest. Updates
 * reuse it, so they cost nothing and a match the person has since corrected
 * (by merging nodes in the graph) is not re-litigated.
 */
import { EntityResolver } from '../graph/resolver';
import { isNoteNode, RawExtractionNode, ResolutionStats, Settings } from '../types';
import type { GraphCache } from '../graph/cache';
import type { MedLitEntity, MedLitKg } from './types';

export interface ResolveOptions {
	/** Use embeddings (and LLM verification, if on) for entities with no exact match. */
	useEmbeddings: boolean;
}

export interface ResolveResult {
	/** med-lit entity id -> graph node id, for every entity in the snapshot. */
	entityMap: Record<string, string>;
	/** How many were decided in this run, as opposed to reused. */
	resolved: number;
	reused: number;
	/** Entities that matched a node that existed before this run. */
	matchedExisting: number;
	stats: ResolutionStats | null;
}

/** Alias sources trusted to name the same thing regardless of type. */
const STRONG_ALIASES = new Set(['canonical', 'merge']);

function aliasMatch(cache: GraphCache, entity: MedLitEntity): string | null {
	for (const { alias, source } of entity.aliases) {
		const node = cache.getNodeByNameOrAlias(alias);
		if (!node || isNoteNode(node)) continue;
		// An acronym or a surface form is a weaker signal: "AI" in a medical
		// paper and "AI" in someone's notes are the same only if they are the
		// same kind of thing.
		if (STRONG_ALIASES.has(source) || node.entityType === entity.sgbType) return node.id;
	}
	return null;
}

export async function resolveProjectEntities(
	cache: GraphCache,
	settings: Settings,
	kg: MedLitKg,
	previous: Record<string, string>,
	options: ResolveOptions
): Promise<ResolveResult> {
	const entityMap: Record<string, string> = {};
	const pending: MedLitEntity[] = [];
	let reused = 0;

	for (const entity of kg.entities) {
		const known = previous[String(entity.id)];
		const node = known ? cache.getNodeById(known) : undefined;
		if (node && !isNoteNode(node)) {
			entityMap[String(entity.id)] = node.id;
			reused++;
		} else {
			pending.push(entity);
		}
	}

	if (pending.length === 0) return { entityMap, resolved: 0, reused, matchedExisting: 0, stats: null };

	const resolver = new EntityResolver(cache, {
		...settings,
		enableEmbeddings: options.useEmbeddings && settings.enableEmbeddings,
	});
	const raw: RawExtractionNode[] = pending.map(entity => ({
		id: `ml:${entity.id}`,
		entityType: entity.sgbType,
		properties: { name: entity.name, description: entity.description || undefined },
	}));
	const results = await resolver.resolveBatch(raw);

	let matchedExisting = 0;
	for (const entity of pending) {
		const result = results.get(`ml:${entity.id}`);
		let nodeId = result?.nodeId;
		if (!result || result.matchType === 'new') {
			nodeId = aliasMatch(cache, entity) ?? nodeId;
		}
		if (!nodeId) continue;
		if (cache.getNodeById(nodeId)) matchedExisting++;
		entityMap[String(entity.id)] = nodeId;
	}

	return { entityMap, resolved: pending.length, reused, matchedExisting, stats: resolver.getStats() };
}

