import { ApiProvider, EmbeddingProvider, LocalApiStyle, OntologyExtractionResult, Settings, EntityType, ExtractionMode, RawExtractionNode, RawExtractionRelationship } from '../types';
import { Vault } from 'obsidian';
import { chunkContent, buildExtractionPrompt } from './prompts';
import { getEmbeddingRequestConfig } from '../settings';
import { postJson } from './providers/http';
import { createError, handleApiError } from './providers/errors';
import { getAdapter } from './providers/index';
import { resolveModelConfig } from './providers/models';
import { EffortLevel } from './providers/effort';
import { JsonSchemaObject } from './providers/types';
import {
	ENTITY_ITEM_SCHEMA,
	EXTRACTION_SCHEMA_NAME,
	ONTOLOGY_JSON_SCHEMA,
	RELATIONSHIP_ITEM_SCHEMA,
	SchemaViolation,
	toProviderSchema,
	validateAgainstSchema,
} from './providers/schemas';

// Re-exported so existing importers (commands/analyze.ts) keep working.
export type { ExtractionError } from './providers/errors';

export interface ExtractionOptions {
	provider: ApiProvider;
	apiKey: string;
	model: string;
	ollamaHost?: string;
	localApiStyle?: LocalApiStyle;
	effort: EffortLevel;
	maxOutputTokens: number;
}

/**
 * Extract ontology (nodes and relationships) from note content using LLM.
 */
export async function extractOntology(
	options: ExtractionOptions,
	prompt: string
): Promise<OntologyExtractionResult> {
	const { provider, apiKey, model } = options;

	// Ollama doesn't need an API key
	if (provider !== 'ollama' && !apiKey) {
		throw createError('config_error', 'API key not configured. Please set your API key in settings.');
	}

	if (!model) {
		throw createError('config_error', 'Model not configured. Please set a model name in settings.');
	}

	if (!getAdapter(provider, { apiKey, ollamaHost: options.ollamaHost, localApiStyle: options.localApiStyle }).capabilities(model).structuredOutput) {
		throw createError(
			'config_error',
			`${model} cannot return structured output, which extraction requires. ` +
				'Choose a different model in settings.'
		);
	}

	try {
		// Extraction is defined in terms of the schema: the request carries it,
		// the reply is validated against it, and a violation is an error rather
		// than something to be guessed around.
		const response = await callLLMProvider(options, prompt, extractionSchemaFor(provider));
		return parseOntologyResponse(response);
	} catch (e) {
		// handleApiError passes typed errors straight through.
		throw handleApiError(e, provider, options.ollamaHost);
	}
}

/**
 * Extract ontology with chunked content for better handling of long notes.
 * Processes chunks in parallel (max 3 concurrent) and merges results.
 */
export async function extractOntologyChunked(
	options: ExtractionOptions,
	content: string,
	existingNodeNames: string[],
	mode: ExtractionMode
): Promise<{ result: OntologyExtractionResult; chunkCount: number }> {
	const chunks = chunkContent(content, 500);

	if (chunks.length === 1) {
		// Single chunk, no need for parallel processing
		const prompt = buildExtractionPrompt(chunks[0], existingNodeNames, mode);
		const result = await extractOntology(options, prompt);
		return { result, chunkCount: 1 };
	}

	// Process in parallel with max 3 concurrent
	const maxConcurrent = 3;
	const results: OntologyExtractionResult[] = [];

	for (let i = 0; i < chunks.length; i += maxConcurrent) {
		const batch = chunks.slice(i, i + maxConcurrent);
		const batchResults = await Promise.all(
			batch.map(async (chunk, batchIndex) => {
				const prompt = buildExtractionPrompt(chunk, existingNodeNames, mode);
				try {
					return await extractOntology(options, prompt);
				} catch (e) {
					console.warn(`Chunk ${i + batchIndex + 1} extraction failed:`, e);
					return { nodes: [], relationships: [] };
				}
			})
		);
		results.push(...batchResults);
	}

	return { result: mergeChunkResults(results), chunkCount: chunks.length };
}

/**
 * Merge extraction results from multiple chunks.
 * Deduplicates nodes by name (case-insensitive).
 */
function mergeChunkResults(results: OntologyExtractionResult[]): OntologyExtractionResult {
	const seenNames = new Set<string>();
	const nodes: RawExtractionNode[] = [];
	const relationships: RawExtractionRelationship[] = [];
	let nodeIdCounter = 1;

	for (const result of results) {
		// Re-map node IDs to avoid conflicts
		const idMap = new Map<string, string>();

		for (const node of result.nodes) {
			const key = node.properties.name.toLowerCase();
			if (!seenNames.has(key)) {
				seenNames.add(key);
				const newId = String(nodeIdCounter++);
				idMap.set(node.id, newId);
				nodes.push({ ...node, id: newId });
			} else {
				// Find existing node with same name and map to its ID
				const existing = nodes.find(n => n.properties.name.toLowerCase() === key);
				if (existing) {
					idMap.set(node.id, existing.id);
				}
			}
		}

		// Remap relationship source/target IDs
		for (const rel of result.relationships) {
			const newSource = idMap.get(rel.source);
			const newTarget = idMap.get(rel.target);
			if (newSource && newTarget) {
				relationships.push({
					...rel,
					source: newSource,
					target: newTarget,
				});
			}
		}
	}

	return { nodes, relationships };
}

/**
 * Helper to create ExtractionOptions from Settings
 */
export function settingsToExtractionOptions(settings: Settings): ExtractionOptions {
	const resolved = resolveModelConfig(settings, 'extraction');
	return {
		provider: resolved.provider,
		apiKey: resolved.apiKey,
		model: resolved.model,
		ollamaHost: resolved.ollamaHost,
		localApiStyle: resolved.localApiStyle,
		effort: resolved.effort,
		maxOutputTokens: resolved.maxOutputTokens,
	};
}

/**
 * Call the appropriate LLM provider for text completion.
 * Shared helper for extractOntology and verifyEntityMatch.
 */
async function callLLMProvider(
	options: ExtractionOptions,
	prompt: string,
	responseSchema?: { name: string; schema: JsonSchemaObject }
): Promise<string> {
	const { provider, apiKey, model, ollamaHost, localApiStyle, effort, maxOutputTokens } = options;
	const creds = { apiKey, ollamaHost, localApiStyle };

	const result = await getAdapter(provider, creds).complete(
		{
			model,
			effort,
			maxOutputTokens,
			responseSchema,
			turns: [{ kind: 'user', text: prompt }],
		},
		creds
	);
	return result.text;
}

/**
 * The extraction schema, in the dialect the given provider accepts.
 */
function extractionSchemaFor(provider: ApiProvider): { name: string; schema: JsonSchemaObject } {
	return {
		name: EXTRACTION_SCHEMA_NAME,
		schema: toProviderSchema(ONTOLOGY_JSON_SCHEMA, provider),
	};
}


// ============================================
// Embedding Functions
// ============================================

export interface EmbeddingOptions {
	provider: EmbeddingProvider;
	apiKey: string;
	model: string;
	/** Base address of the local embedding server. */
	ollamaHost?: string;
	/** Which API that local server speaks. Independent of the chat provider. */
	localApiStyle?: LocalApiStyle;
}

/**
 * Get embeddings for a batch of texts.
 * Returns an array of Float32Arrays, one per input text.
 */
export async function getEmbeddings(
	options: EmbeddingOptions,
	texts: string[]
): Promise<Float32Array[]> {
	const { provider, apiKey, model, ollamaHost, localApiStyle } = options;

	// A local server usually needs no API key.
	if (provider !== 'ollama' && !apiKey) {
		throw createError('config_error', 'Embedding API key not configured.');
	}

	if (!model) {
		throw createError('config_error', 'Embedding model not configured.');
	}

	if (texts.length === 0) {
		return [];
	}

	try {
		switch (provider) {
			case 'openai':
				return await callOpenAIEmbeddings(apiKey, model, texts);
			case 'gemini':
				return await callGeminiEmbeddings(apiKey, model, texts);
			case 'ollama': {
				const host = (ollamaHost || 'http://localhost:11434').replace(/\/+$/, '');
				return localApiStyle === 'openai'
					? await callOpenAiStyleEmbeddings(
						`${host}${/\/v\d+$/.test(host) ? '' : '/v1'}/embeddings`,
						apiKey,
						model,
						texts,
						'ollama',
						host
					)
					: await callOllamaEmbeddings(host, model, texts);
			}
			default: {
				const exhaustiveCheck: never = provider;
				throw createError('config_error', `Unknown embedding provider: ${exhaustiveCheck as string}`);
			}
		}
	} catch (e) {
		// handleApiError passes typed errors straight through.
		throw handleApiError(e, provider, ollamaHost);
	}
}

/**
 * Helper to create EmbeddingOptions from Settings.
 */
export function settingsToEmbeddingOptions(settings: Settings): EmbeddingOptions {
	return {
		provider: settings.embeddingProvider,
		apiKey: settings.embeddingApiKey || settings.apiKey, // Fall back to main API key
		model: settings.embeddingModel,
		// The embedding server need not be the chat server: a local chat model
		// does not imply a local embedding model. Fall back to the chat host
		// only when no separate one is configured.
		ollamaHost: settings.embeddingHost || settings.ollamaHost,
		localApiStyle: settings.embeddingLocalApiStyle ?? 'ollama',
	};
}

function callOpenAIEmbeddings(apiKey: string, model: string, texts: string[]): Promise<Float32Array[]> {
	return callOpenAiStyleEmbeddings(
		'https://api.openai.com/v1/embeddings',
		apiKey,
		model,
		texts,
		'openai'
	);
}

/**
 * The OpenAI `/v1/embeddings` shape, which OpenAI itself and every
 * OpenAI-compatible local server (llama-server, LM Studio, vLLM) implement.
 */
async function callOpenAiStyleEmbeddings(
	url: string,
	apiKey: string,
	model: string,
	texts: string[],
	provider: EmbeddingProvider,
	ollamaHost?: string
): Promise<Float32Array[]> {
	const data = await postJson<{ data?: { index: number; embedding: number[] }[] }>({
		url,
		provider,
		ollamaHost,
		// A local server started without --api-key needs no Authorization header.
		headers: apiKey ? { 'Authorization': `Bearer ${apiKey}` } : undefined,
		body: {
			model: model,
			input: texts,
		},
	});

	if (!data.data || !Array.isArray(data.data)) {
		throw createError('api_error', `Invalid response from the ${provider} embeddings API`);
	}

	if (data.data.length !== texts.length) {
		throw createError(
			'api_error',
			`Embeddings API returned ${data.data.length} vectors for ${texts.length} inputs.`
		);
	}

	// Sort by index to ensure correct order
	const sorted = data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index);
	return sorted.map((item: { embedding: number[] }) => new Float32Array(item.embedding));
}

async function callGeminiEmbeddings(apiKey: string, model: string, texts: string[]): Promise<Float32Array[]> {
	// The catalogue id may encode a Matryoshka truncation width
	// (gemini-embedding-001@768); the API only knows the bare model name.
	const { apiModel, outputDimensionality } = getEmbeddingRequestConfig('gemini', model);

	const data = await postJson<{
		error?: { message?: string };
		embeddings?: { values: number[] }[];
	}>({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${apiModel}:batchEmbedContents`,
		provider: 'gemini',
		headers: {
			'x-goog-api-key': apiKey,
		},
		body: {
			requests: texts.map(text => ({
				model: `models/${apiModel}`,
				content: { parts: [{ text }] },
				...(outputDimensionality ? { outputDimensionality } : {}),
			})),
		},
	});

	if (data.error) {
		throw createError('api_error', `Gemini embeddings error: ${data.error.message || JSON.stringify(data.error)}`);
	}

	if (!data.embeddings || !Array.isArray(data.embeddings)) {
		throw createError('api_error', 'Invalid response from Gemini embeddings API');
	}

	return data.embeddings.map((item: { values: number[] }) => new Float32Array(item.values));
}

async function callOllamaEmbeddings(host: string, model: string, texts: string[]): Promise<Float32Array[]> {
	const baseUrl = host.replace(/\/+$/, '');
	const results: Float32Array[] = [];

	// /api/embed supersedes /api/embeddings and takes the whole batch in one
	// request, instead of one HTTP round trip per text.
	const data = await postJson<{ embeddings?: number[][] }>({
		url: `${baseUrl}/api/embed`,
		provider: 'ollama',
		ollamaHost: baseUrl,
		body: {
			model: model,
			input: texts,
		},
	});

	if (!Array.isArray(data.embeddings)) {
		throw createError('api_error', 'Invalid response from Ollama embeddings API');
	}

	if (data.embeddings.length !== texts.length) {
		throw createError(
			'api_error',
			`Ollama returned ${data.embeddings.length} embeddings for ${texts.length} inputs.`
		);
	}

	for (const values of data.embeddings) {
		results.push(new Float32Array(values));
	}

	return results;
}

// ============================================
// Cosine Similarity (Pure JS)
// ============================================

/**
 * Calculate cosine similarity between two vectors.
 * Returns a value between -1 and 1, where 1 means identical.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) {
		throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	}

	let dotProduct = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dotProduct += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
	if (magnitude === 0) return 0;

	return dotProduct / magnitude;
}

/**
 * Find the most similar embedding from a list.
 * Returns { index, similarity } or null if no match above threshold.
 */
export function findMostSimilar(
	query: Float32Array,
	embeddings: Float32Array[],
	threshold: number = 0.0
): { index: number; similarity: number } | null {
	let bestIndex = -1;
	let bestSimilarity = threshold;

	for (let i = 0; i < embeddings.length; i++) {
		const sim = cosineSimilarity(query, embeddings[i]);
		if (sim > bestSimilarity) {
			bestSimilarity = sim;
			bestIndex = i;
		}
	}

	if (bestIndex === -1) return null;
	return { index: bestIndex, similarity: bestSimilarity };
}

/**
 * Find all embeddings similar to query within a threshold range.
 */
export function findSimilarInRange(
	query: Float32Array,
	embeddings: Float32Array[],
	minThreshold: number,
	maxThreshold: number
): Array<{ index: number; similarity: number }> {
	const results: Array<{ index: number; similarity: number }> = [];

	for (let i = 0; i < embeddings.length; i++) {
		const sim = cosineSimilarity(query, embeddings[i]);
		if (sim >= minThreshold && sim < maxThreshold) {
			results.push({ index: i, similarity: sim });
		}
	}

	// Sort by similarity descending
	return results.sort((a, b) => b.similarity - a.similarity);
}

// ============================================
// Binary Embedding Storage
// ============================================

const EMBEDDINGS_FILENAME = 'embeddings.bin';

/**
 * Save embeddings to binary file.
 * Format: [count: uint32][embedding0][embedding1]...
 * Each embedding is dimensions * 4 bytes (Float32Array).
 */
export async function saveEmbeddingsBinary(
	vault: Vault,
	pluginDir: string,
	embeddings: Map<string, Float32Array>,
	nodeIds: string[],
	dimensions: number
): Promise<void> {
	if (nodeIds.length === 0) {
		// Remove file if no embeddings
		try {
			const filePath = `${pluginDir}/${EMBEDDINGS_FILENAME}`;
			const existingFile = vault.getAbstractFileByPath(filePath);
			if (existingFile) {
				await vault.delete(existingFile, true);
			}
		} catch {
			// Ignore if file doesn't exist
		}
		return;
	}

	// Header: 4 bytes for count
	const headerSize = 4;
	const embeddingSize = dimensions * 4; // Float32 = 4 bytes
	const totalSize = headerSize + nodeIds.length * embeddingSize;

	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);

	// Write header
	view.setUint32(0, nodeIds.length, true); // little-endian

	// Write embeddings in order of nodeIds
	for (let i = 0; i < nodeIds.length; i++) {
		const nodeId = nodeIds[i];
		const embedding = embeddings.get(nodeId);

		if (!embedding) {
			// Fill with zeros if embedding is missing
			console.warn(`Missing embedding for node ${nodeId}, filling with zeros`);
			continue;
		}

		// A width mismatch means these vectors came from a different embedding
		// model. Writing anyway would be silently destructive: TypedArray.set
		// zero-pads a shorter source and throws on a longer one, so half the
		// file would end up as plausible-looking garbage.
		if (embedding.length !== dimensions) {
			throw createError(
				'config_error',
				`Refusing to write embeddings: node ${nodeId} has ${embedding.length} dimensions but the ` +
					`configured model produces ${dimensions}. Recompute embeddings after changing model.`
			);
		}

		const offset = headerSize + i * embeddingSize;
		const embeddingView = new Float32Array(buffer, offset, dimensions);
		embeddingView.set(embedding);
	}

	// Write to file
	const filePath = `${pluginDir}/${EMBEDDINGS_FILENAME}`;
	await vault.adapter.writeBinary(filePath, buffer);
}

/**
 * Load embeddings from binary file.
 * Returns a Map from node ID to embedding.
 */
export async function loadEmbeddingsBinary(
	vault: Vault,
	pluginDir: string,
	nodeIds: string[],
	dimensions: number
): Promise<Map<string, Float32Array>> {
	const result = new Map<string, Float32Array>();

	const filePath = `${pluginDir}/${EMBEDDINGS_FILENAME}`;

	try {
		const buffer = await vault.adapter.readBinary(filePath);
		const view = new DataView(buffer);

		// Read header
		const count = view.getUint32(0, true);

		if (count !== nodeIds.length) {
			console.warn(`Embedding count mismatch: file has ${count}, expected ${nodeIds.length}`);
		}

		const headerSize = 4;
		const embeddingSize = dimensions * 4;

		// Read embeddings
		const readCount = Math.min(count, nodeIds.length);
		for (let i = 0; i < readCount; i++) {
			const offset = headerSize + i * embeddingSize;

			// Check if we have enough data
			if (offset + embeddingSize > buffer.byteLength) {
				console.warn(`Truncated embedding file at index ${i}`);
				break;
			}

			const embedding = new Float32Array(buffer, offset, dimensions);
			result.set(nodeIds[i], new Float32Array(embedding)); // Copy to detach from buffer
		}
	} catch {
		// File doesn't exist or can't be read
		console.debug('No embeddings file found, starting fresh');
	}

	return result;
}

// ============================================
// LLM Verification for Ambiguous Matches
// ============================================

/**
 * Ask LLM to verify if two entities refer to the same thing.
 */
export async function verifyEntityMatch(
	options: ExtractionOptions,
	entity1: { name: string; label: string; description?: string },
	entity2: { name: string; label: string; description?: string }
): Promise<boolean> {
	const prompt = `You are an entity resolution expert. Determine if these two entities refer to the same real-world entity.

Entity 1:
- Name: "${entity1.name}"
- Type: ${entity1.label}
${entity1.description ? `- Description: ${entity1.description}` : ''}

Entity 2:
- Name: "${entity2.name}"
- Type: ${entity2.label}
${entity2.description ? `- Description: ${entity2.description}` : ''}

Answer with ONLY "yes" or "no".
- "yes" = they refer to the same entity (e.g., "AI" and "Artificial Intelligence", "ML" and "Machine Learning")
- "no" = they are different entities (e.g., "Apple (company)" and "apple (fruit)")`;

	try {
		// A yes/no answer called once per candidate pair inside the resolver's
		// loop. Reasoning here is pure cost, so pin effort low and cap the
		// output regardless of the user's extraction setting.
		const response = await callLLMProvider(
			{ ...options, effort: 'minimal', maxOutputTokens: 16 },
			prompt
		);
		const answer = response.toLowerCase().trim();
		return answer === 'yes' || answer.startsWith('yes');
	} catch (e) {
		console.error('LLM verification failed:', e);
		return false; // Default to not merging on error
	}
}

// ============================================
// Response Parsing
// ============================================

/**
 * Extract the JSON body from a reply.
 *
 * Extraction requests always carry a JSON schema, so a conforming reply is bare
 * JSON and this is a no-op passthrough. Needing to strip a markdown fence or dig
 * a JSON object out of surrounding prose means the model ignored its schema —
 * worth a warning, because it usually points at a local model that accepted
 * `format` without honouring it.
 */
function extractJsonFromResponse(response: string): string {
	let jsonStr = response.trim();

	// Handle various markdown code block formats
	const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonStr = codeBlockMatch[1].trim();
	}

	// Try to find JSON object if response has extra text
	if (!jsonStr.startsWith('{')) {
		const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonStr = jsonMatch[0];
		}
	}

	if (jsonStr !== response.trim()) {
		console.warn(
			'[simple-graph-builder] Model returned a schema-violating reply; recovered the JSON body. ' +
				'If this recurs, the selected model is not honouring structured output.'
		);
	}

	return jsonStr;
}

/**
 * Safely convert a value to a string ID.
 */
function toStringId(value: unknown, fallback: string): string {
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number') {
		return String(value);
	}
	return fallback;
}

/**
 * Parse entities from parsed JSON object.
 * Handles both new schema (entities) and legacy schema (nodes).
 */
function parseEntities(parsed: Record<string, unknown>): RawExtractionNode[] {
	const rawEntities = (parsed.entities ?? []) as Record<string, unknown>[];
	const nodes: RawExtractionNode[] = [];
	const dropped: { index: number; violations: SchemaViolation[] }[] = [];
	let idCounter = 1;

	for (const [index, entity] of rawEntities.entries()) {
		// Case is the one deviation worth absorbing: "person" carries the same
		// meaning as "PERSON". Everything else is checked as-is.
		const candidate = normalizeEntityCase(entity);

		const violations = validateAgainstSchema(candidate, ENTITY_ITEM_SCHEMA, `$.entities[${index}]`);
		if (violations.length) {
			dropped.push({ index, violations });
			continue;
		}

		const name = (candidate as { name: string }).name;
		const description = (candidate as { description?: string }).description;

		nodes.push({
			id: String(idCounter++),
			entityType: (candidate as { entity_type: EntityType }).entity_type,
			properties: {
				name: name.trim(),
				description: description || undefined,
			},
		});
	}

	reportDropped('entities', dropped);
	return nodes;
}

/**
 * Uppercase `entity_type` so a case variant is not treated as a violation.
 * Returns a copy; never mutates the parsed payload.
 */
function normalizeEntityCase(entity: unknown): unknown {
	if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return entity;
	const e = entity as Record<string, unknown>;
	if (typeof e.entity_type !== 'string') return entity;
	return { ...e, entity_type: e.entity_type.toUpperCase() };
}

/**
 * Resolve an ID string, trying name lookup if not found directly.
 */
function resolveId(
	rawId: unknown,
	nodes: RawExtractionNode[],
	nameToId: Map<string, string>
): string {
	const id = toStringId(rawId, '');
	if (!id) return '';

	// Check if it's a direct node ID
	if (nodes.some(n => n.id === id)) {
		return id;
	}

	// Try to resolve as a name
	return nameToId.get(id.toLowerCase()) || id;
}


/**
 * Parse relationships from parsed JSON object.
 * Resolves entity names to IDs using the provided name-to-id map.
 */
function parseRelationships(
	parsed: Record<string, unknown>,
	nodes: RawExtractionNode[],
	nameToId: Map<string, string>
): RawExtractionRelationship[] {
	const rawRelationships = (parsed.relationships ?? []) as Record<string, unknown>[];
	const relationships: RawExtractionRelationship[] = [];
	const dropped: { index: number; violations: SchemaViolation[] }[] = [];

	for (const [index, rel] of rawRelationships.entries()) {
		const violations = validateAgainstSchema(
			rel,
			RELATIONSHIP_ITEM_SCHEMA,
			`$.relationships[${index}]`
		);
		if (violations.length) {
			dropped.push({ index, violations });
			continue;
		}

		// Endpoints are entity names; map them onto the ids assigned above. A
		// relationship naming an entity that was never extracted is dropped.
		const sourceId = resolveId(rel.source, nodes, nameToId);
		const targetId = resolveId(rel.target, nodes, nameToId);
		if (!sourceId || !targetId) {
			dropped.push({
				index,
				violations: [{ path: `$.relationships[${index}]`, message: 'endpoint is not a known entity' }],
			});
			continue;
		}

		const relationship = (rel as { relationship: string }).relationship;
		const detail = (rel as { description?: string }).description;

		relationships.push({
			source: sourceId,
			target: targetId,
			relationship: relationship.toLowerCase(),
			properties: {
				detail: detail || undefined,
			},
		});
	}

	reportDropped('relationships', dropped);
	return relationships;
}

/**
 * Parse LLM response into OntologyExtractionResult.
 * Handles both new schema (entities/relationships) and legacy schema (nodes/relationships).
 */
function parseOntologyResponse(response: string): OntologyExtractionResult {
	const jsonStr = extractJsonFromResponse(response);

	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(jsonStr) as Record<string, unknown>;
	} catch {
		console.error('Failed to parse LLM response:', response);
		throw createError('parse_error', 'Failed to parse extraction result from LLM', response.slice(0, 200));
	}

	// Validity pass. The request carried a JSON schema, so the reply is expected
	// to conform; anything that does not is a broken contract rather than a
	// shape to be guessed at.
	const envelope = validateEnvelope(parsed);
	if (envelope.length) {
		console.error('Extraction response failed schema validation:', envelope, response.slice(0, 400));
		throw createError(
			'parse_error',
			'The model returned a response that does not match the extraction schema.',
			envelope.map((v) => `${v.path}: ${v.message}`).join('; ')
		);
	}

	const nodes = parseEntities(parsed);

	// Build name-to-id map for relationship resolution
	const nameToId = new Map<string, string>();
	for (const node of nodes) {
		nameToId.set(node.properties.name.toLowerCase(), node.id);
	}

	const relationships = parseRelationships(parsed, nodes, nameToId);

	return { nodes, relationships };
}

/**
 * Envelope-level validation: the two arrays must be present and be arrays.
 * Anything wrong here means the payload is unusable, so it throws. Individual
 * malformed items are reported and dropped by parseEntities /
 * parseRelationships instead, so one bad entity cannot discard a whole chunk.
 */
function validateEnvelope(parsed: unknown): SchemaViolation[] {
	return validateAgainstSchema(parsed, {
		type: 'object',
		required: ['entities', 'relationships'],
		properties: {
			entities: { type: 'array' },
			relationships: { type: 'array' },
		},
	});
}

/**
 * Report dropped items once per chunk rather than once per item.
 */
function reportDropped(kind: string, dropped: { index: number; violations: SchemaViolation[] }[]): void {
	if (!dropped.length) return;
	const detail = dropped
		.map((d) => `[${d.index}] ${d.violations.map((v) => `${v.path}: ${v.message}`).join(', ')}`)
		.join(' | ');
	console.warn(
		`[simple-graph-builder] Dropped ${dropped.length} ${kind} that violated the extraction schema: ${detail}`
	);
}
