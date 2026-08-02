import { OntologyNode, RawExtractionNode, ResolutionResult, ResolutionStats, Settings, getNodeEntityType, getEdgeRelationship, normalizeKey } from '../types';
import { GraphCache } from './cache';
import { getEmbeddings, settingsToEmbeddingOptions, verifyEntityMatch, settingsToExtractionOptions, EmbeddingOptions } from '../extraction/llm-client';
import { generateNodeId, generateEdgeId } from './merge';

/**
 * EntityResolver implements a multi-stage hybrid entity resolution pipeline.
 *
 * Resolution order (priority from highest to lowest):
 * 1. Persistent resolution cache (O(1)) - token already resolved before
 * 2. Session cache (O(1)) - same name already resolved this session
 * 3. Exact name match (O(1)) - hash lookup on node names
 * 4. Alias match (O(1)) - hash lookup on stored aliases
 * 5. Embedding similarity (>threshold) - cosine similarity search
 * 6. LLM verification - for ambiguous matches
 * 7. Create new entity - if no match found
 */
export class EntityResolver {
	private sessionCache: Map<string, ResolutionResult> = new Map();
	private cache: GraphCache;
	private settings: Settings;
	private embeddingOptions: EmbeddingOptions | null = null;

	// Stats for current resolution batch
	private stats: ResolutionStats = {
		cached: 0,
		session: 0,
		exact: 0,
		alias: 0,
		embeddingHigh: 0,
		embeddingVerified: 0,
		new: 0,
	};

	constructor(cache: GraphCache, settings: Settings) {
		this.cache = cache;
		this.settings = settings;

		if (settings.enableEmbeddings) {
			this.embeddingOptions = settingsToEmbeddingOptions(settings);
		}
	}

	/**
	 * Clear session cache for a new analysis session.
	 */
	clearSession(): void {
		this.sessionCache.clear();
		this.stats = {
			cached: 0,
			session: 0,
			exact: 0,
			alias: 0,
			embeddingHigh: 0,
			embeddingVerified: 0,
			new: 0,
		};
	}

	/**
	 * Get stats from the current resolution session.
	 */
	getStats(): ResolutionStats {
		return { ...this.stats };
	}

	/**
	 * Try to resolve using cache lookups only (steps 1-4).
	 * Returns the result if found, null if embedding resolution is needed.
	 */
	private tryResolveFromCaches(lowerName: string): ResolutionResult | null {
		// 1. Check persistent resolution cache (O(1))
		const cachedNodeId = this.cache.getResolvedNodeId(lowerName);
		if (cachedNodeId) {
			const node = this.cache.getNodeById(cachedNodeId);
			if (node) {
				this.stats.cached++;
				const result: ResolutionResult = {
					nodeId: cachedNodeId,
					matchType: 'cached',
					confidence: 1.0,
					mergedInto: node.properties.name,
				};
				this.sessionCache.set(lowerName, result);
				return result;
			}
			// Cached node no longer exists, remove from cache
			this.cache.uncacheResolution(lowerName);
		}

		// 2. Check session cache (O(1))
		const sessionResult = this.sessionCache.get(lowerName);
		if (sessionResult) {
			this.stats.session++;
			return sessionResult;
		}

		// 3. Exact name match (O(1))
		const exactMatch = this.cache.getNodeByName(lowerName);
		if (exactMatch) {
			this.stats.exact++;
			const result: ResolutionResult = {
				nodeId: exactMatch.id,
				matchType: 'exact',
				confidence: 1.0,
			};
			this.sessionCache.set(lowerName, result);
			this.cache.cacheResolution(lowerName, exactMatch.id);
			return result;
		}

		// 4. Alias match (O(1))
		const aliasMatch = this.cache.getNodeByAlias(lowerName);
		if (aliasMatch) {
			this.stats.alias++;
			const result: ResolutionResult = {
				nodeId: aliasMatch.id,
				matchType: 'alias',
				confidence: 1.0,
				mergedInto: aliasMatch.properties.name,
			};
			this.sessionCache.set(lowerName, result);
			this.cache.cacheResolution(lowerName, aliasMatch.id);
			return result;
		}

		return null;
	}

	/**
	 * Create a "new entity" resolution result.
	 */
	private createNewEntityResult(rawNode: RawExtractionNode, lowerName: string): ResolutionResult {
		const nodeId = generateNodeId(rawNode.entityType, rawNode.properties.name);
		this.stats.new++;
		const result: ResolutionResult = {
			nodeId,
			matchType: 'new',
			confidence: 0.0,
		};
		this.sessionCache.set(lowerName, result);
		return result;
	}

	/**
	 * Resolve a single raw node to either an existing node or create a new one.
	 * Returns the resolution result with the node ID and match type.
	 */
	async resolve(rawNode: RawExtractionNode): Promise<ResolutionResult> {
		const name = rawNode.properties.name;
		const lowerName = normalizeKey(name);

		// Steps 1-4: Try cache lookups
		const cacheResult = this.tryResolveFromCaches(lowerName);
		if (cacheResult) {
			return cacheResult;
		}

		// Steps 5-6: Embedding-based resolution (if enabled)
		if (this.settings.enableEmbeddings && this.embeddingOptions) {
			const embeddingResult = await this.resolveByEmbedding(rawNode, name);
			if (embeddingResult) {
				this.sessionCache.set(lowerName, embeddingResult);
				return embeddingResult;
			}
		}

		// Step 7: Create new entity
		return this.createNewEntityResult(rawNode, lowerName);
	}

	/**
	 * Resolve multiple raw nodes in batch.
	 * More efficient for embeddings as it can batch API calls.
	 */
	async resolveBatch(rawNodes: RawExtractionNode[]): Promise<Map<string, ResolutionResult>> {
		const results = new Map<string, ResolutionResult>();
		const needsEmbedding: RawExtractionNode[] = [];

		// First pass: resolve using cache lookups
		for (const rawNode of rawNodes) {
			const lowerName = normalizeKey(rawNode.properties.name);
			const cacheResult = this.tryResolveFromCaches(lowerName);

			if (cacheResult) {
				results.set(rawNode.id, cacheResult);
			} else {
				needsEmbedding.push(rawNode);
			}
		}

		// Second pass: embedding-based resolution or create new
		if (this.settings.enableEmbeddings && this.embeddingOptions && needsEmbedding.length > 0) {
			await this.resolveByEmbeddingBatch(needsEmbedding, results);
		} else {
			for (const rawNode of needsEmbedding) {
				const lowerName = normalizeKey(rawNode.properties.name);
				results.set(rawNode.id, this.createNewEntityResult(rawNode, lowerName));
			}
		}

		return results;
	}

	/**
	 * Resolve a single entity using embedding similarity.
	 */
	private async resolveByEmbedding(
		rawNode: RawExtractionNode,
		name: string
	): Promise<ResolutionResult | null> {
		if (!this.embeddingOptions) return null;

		await this.cache.ensureEmbeddingsLoaded();

		let queryEmbedding: Float32Array;
		try {
			const embeddings = await getEmbeddings(this.embeddingOptions, [name]);
			if (embeddings.length === 0) return null;
			queryEmbedding = embeddings[0];
		} catch (e) {
			console.error('Failed to get embedding:', e);
			return null;
		}

		return this.matchByEmbedding(rawNode, name, queryEmbedding);
	}

	/**
	 * Match entity using embedding similarity (shared logic for single and batch).
	 */
	private async matchByEmbedding(
		rawNode: RawExtractionNode,
		name: string,
		queryEmbedding: Float32Array
	): Promise<ResolutionResult | null> {
		// High-confidence match (auto-merge)
		const highMatches = this.cache.findSimilarByEmbedding(
			queryEmbedding,
			this.settings.resolutionThresholdHigh,
			rawNode.entityType
		);

		if (highMatches.length > 0) {
			const best = highMatches[0];
			this.stats.embeddingHigh++;

			this.cache.addAliasToNode(best.node.id, name);
			this.cache.cacheResolution(normalizeKey(name), best.node.id);
			this.cache.setEmbedding(best.node.id, queryEmbedding);

			return {
				nodeId: best.node.id,
				matchType: 'embedding_high',
				confidence: best.similarity,
				mergedInto: best.node.properties.name,
			};
		}

		// Ambiguous match (LLM verification needed)
		if (this.settings.enableLLMVerification) {
			const candidates = this.cache.findCandidatesInRange(
				queryEmbedding,
				this.settings.resolutionThresholdLow,
				this.settings.resolutionThresholdHigh,
				rawNode.entityType
			);

			for (const candidate of candidates) {
				const candidateDescription = candidate.node.properties.description;
				const isMatch = await verifyEntityMatch(
					settingsToExtractionOptions(this.settings),
					{
						name,
						label: rawNode.entityType,
						description: rawNode.properties.description,
					},
					{
						name: candidate.node.properties.name,
						label: getNodeEntityType(candidate.node),
						description: typeof candidateDescription === 'string' ? candidateDescription : undefined,
					}
				);

				if (isMatch) {
					this.stats.embeddingVerified++;

					this.cache.addAliasToNode(candidate.node.id, name);
					this.cache.cacheResolution(normalizeKey(name), candidate.node.id);

					return {
						nodeId: candidate.node.id,
						matchType: 'embedding_verified',
						confidence: candidate.similarity,
						mergedInto: candidate.node.properties.name,
					};
				}
			}
		}

		// No match found - store embedding for the new entity
		const nodeId = generateNodeId(rawNode.entityType, name);
		this.cache.setEmbedding(nodeId, queryEmbedding);

		return null;
	}

	/**
	 * Batch embedding resolution for multiple entities.
	 */
	private async resolveByEmbeddingBatch(
		rawNodes: RawExtractionNode[],
		results: Map<string, ResolutionResult>
	): Promise<void> {
		if (!this.embeddingOptions || rawNodes.length === 0) return;

		await this.cache.ensureEmbeddingsLoaded();

		const names = rawNodes.map(n => n.properties.name);
		let queryEmbeddings: Float32Array[];

		try {
			queryEmbeddings = await getEmbeddings(this.embeddingOptions, names);
		} catch (e) {
			console.error('Failed to get batch embeddings:', e);
			// Fall back to creating new entities
			for (const rawNode of rawNodes) {
				const lowerName = normalizeKey(rawNode.properties.name);
				results.set(rawNode.id, this.createNewEntityResult(rawNode, lowerName));
			}
			return;
		}

		// Process each entity
		for (let i = 0; i < rawNodes.length; i++) {
			const rawNode = rawNodes[i];
			const name = rawNode.properties.name;
			const lowerName = normalizeKey(name);
			const queryEmbedding = queryEmbeddings[i];

			const embeddingResult = await this.matchByEmbedding(rawNode, name, queryEmbedding);

			if (embeddingResult) {
				results.set(rawNode.id, embeddingResult);
				this.sessionCache.set(lowerName, embeddingResult);
			} else {
				results.set(rawNode.id, this.createNewEntityResult(rawNode, lowerName));
			}
		}
	}

	/**
	 * Merge an entity into another (manual merge).
	 * The source entity's name becomes an alias of the target.
	 */
	mergeEntities(sourceNodeId: string, targetNodeId: string): boolean {
		const sourceNode = this.cache.getNodeById(sourceNodeId);
		const targetNode = this.cache.getNodeById(targetNodeId);

		if (!sourceNode || !targetNode) {
			console.error('Cannot merge: source or target node not found');
			return false;
		}

		if (sourceNodeId === targetNodeId) {
			console.error('Cannot merge: source and target are the same');
			return false;
		}

		// Merge aliases
		this.mergeAliases(sourceNode, targetNodeId);

		// Merge source notes
		this.mergeSourceNotes(sourceNode, targetNode);

		// Redirect edges
		this.redirectEdges(sourceNodeId, targetNodeId);

		// Transfer embedding if needed
		const sourceEmbedding = this.cache.getEmbedding(sourceNodeId);
		if (sourceEmbedding && !this.cache.hasEmbedding(targetNodeId)) {
			this.cache.setEmbedding(targetNodeId, sourceEmbedding);
		}

		// Remove source node
		this.cache.removeNode(sourceNodeId);
		this.cache.removeEmbedding(sourceNodeId);

		return true;
	}

	/**
	 * Merge aliases from source node to target.
	 */
	private mergeAliases(sourceNode: OntologyNode, targetNodeId: string): void {
		this.cache.addAliasToNode(targetNodeId, sourceNode.properties.name);
		this.cache.cacheResolution(normalizeKey(sourceNode.properties.name), targetNodeId);

		const sourceAliases = sourceNode.properties.aliases || [];
		for (const alias of sourceAliases) {
			this.cache.addAliasToNode(targetNodeId, alias);
			this.cache.cacheResolution(normalizeKey(alias), targetNodeId);
		}
	}

	/**
	 * Merge source notes from source node to target.
	 */
	private mergeSourceNotes(sourceNode: OntologyNode, targetNode: OntologyNode): void {
		for (const notePath of sourceNode.sourceNotes) {
			if (!targetNode.sourceNotes.includes(notePath)) {
				targetNode.sourceNotes.push(notePath);
			}
		}
		targetNode.updatedAt = Date.now();
	}

	/**
	 * Redirect edges from source node to target node.
	 */
	private redirectEdges(sourceNodeId: string, targetNodeId: string): void {
		const sourceEdges = this.cache.getConnectedEdges(sourceNodeId);

		for (const edge of sourceEdges) {
			const relationship = getEdgeRelationship(edge);
			if (edge.source === sourceNodeId && edge.target !== targetNodeId) {
				const existingEdges = this.cache.getEdgesBySource(targetNodeId);
				const exists = existingEdges.some(e => e.target === edge.target && (e.relationship || e.type) === relationship);
				if (!exists) {
					const newEdgeId = generateEdgeId(targetNodeId, edge.target, relationship);
					this.cache.addEdge({ ...edge, source: targetNodeId, id: newEdgeId });
				}
			} else if (edge.target === sourceNodeId && edge.source !== targetNodeId) {
				const existingEdges = this.cache.getEdgesByTarget(targetNodeId);
				const exists = existingEdges.some(e => e.source === edge.source && (e.relationship || e.type) === relationship);
				if (!exists) {
					const newEdgeId = generateEdgeId(edge.source, targetNodeId, relationship);
					this.cache.addEdge({ ...edge, target: targetNodeId, id: newEdgeId });
				}
			}
		}
	}
}
