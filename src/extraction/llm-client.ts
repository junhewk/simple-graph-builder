import { ApiProvider, EmbeddingProvider, OntologyExtractionResult, Settings, EntityType, ExtractionMode, isValidEntityType, RawExtractionNode, RawExtractionRelationship } from '../types';
import { requestUrl, Vault } from 'obsidian';
import { chunkContent, buildExtractionPrompt } from './prompts';

export interface ExtractionError {
	type: 'api_error' | 'parse_error' | 'config_error' | 'rate_limit';
	message: string;
	details?: string;
}

export interface ExtractionOptions {
	provider: ApiProvider;
	apiKey: string;
	model: string;
	ollamaHost?: string;
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

	try {
		const response = await callLLMProvider(options, prompt);
		return parseOntologyResponse(response);
	} catch (e) {
		if (e instanceof Error && 'type' in e) {
			throw e; // Already an ExtractionError
		}
		throw handleApiError(e, provider);
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
	// Get the model for the current provider
	const modelMap: Record<ApiProvider, string> = {
		claude: settings.claudeModel,
		openai: settings.openaiModel,
		gemini: settings.geminiModel,
		ollama: settings.ollamaModel,
	};

	return {
		provider: settings.apiProvider,
		apiKey: settings.apiKey,
		model: modelMap[settings.apiProvider],
		ollamaHost: settings.ollamaHost,
	};
}

function createError(type: ExtractionError['type'], message: string, details?: string): Error {
	const error = new Error(message) as Error & ExtractionError;
	error.type = type;
	error.details = details;
	return error;
}

/**
 * Call the appropriate LLM provider for text completion.
 * Shared helper for extractOntology and verifyEntityMatch.
 */
async function callLLMProvider(options: ExtractionOptions, prompt: string): Promise<string> {
	const { provider, apiKey, model, ollamaHost } = options;

	switch (provider) {
		case 'claude':
			return callClaude(apiKey, model, prompt);
		case 'openai':
			return callOpenAI(apiKey, model, prompt);
		case 'gemini':
			return callGemini(apiKey, model, prompt);
		case 'ollama':
			return callOllama(ollamaHost || 'http://localhost:11434', model, prompt);
		default:
			throw createError('config_error', `Unknown provider: ${provider as string}`);
	}
}

function handleApiError(e: unknown, provider: ApiProvider | EmbeddingProvider): Error {
	const err = e as { status?: number; message?: string };

	if (err.status === 401) {
		return createError('api_error', `Invalid ${provider} API key. Please check your settings.`);
	}
	if (err.status === 429) {
		return createError('rate_limit', `Rate limit exceeded for ${provider}. Please wait and try again.`);
	}
	if (err.status === 400) {
		return createError('api_error', `Bad request to ${provider} API.`, err.message);
	}
	if (err.status && err.status >= 500) {
		return createError('api_error', `${provider} API server error. Please try again later.`);
	}

	return createError('api_error', `Failed to call ${provider} API: ${err.message || 'Unknown error'}`);
}

async function callClaude(apiKey: string, model: string, prompt: string): Promise<string> {
	const res = await requestUrl({
		url: 'https://api.anthropic.com/v1/messages',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
		},
		body: JSON.stringify({
			model: model,
			messages: [{ role: 'user', content: prompt }],
		}),
	});

	const data = res.json;
	if (!data.content?.[0]?.text) {
		throw createError('api_error', 'Empty response from Claude API');
	}
	return data.content[0].text;
}

async function callOpenAI(apiKey: string, model: string, prompt: string): Promise<string> {
	const res = await requestUrl({
		url: 'https://api.openai.com/v1/chat/completions',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: model,
			messages: [{ role: 'user', content: prompt }],
			temperature: 0.3,
		}),
	});

	const data = res.json;
	if (!data.choices?.[0]?.message?.content) {
		throw createError('api_error', 'Empty response from OpenAI API');
	}
	return data.choices[0].message.content;
}

async function callGemini(apiKey: string, model: string, prompt: string): Promise<string> {
	console.debug(`[Gemini] Calling model: ${model}, prompt length: ${prompt.length} chars`);

	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.3,
			},
		}),
	});

	const data = res.json;

	if (data.error) {
		console.error('Gemini API error:', data.error);
		throw createError('api_error', `Gemini API error: ${data.error.message || JSON.stringify(data.error)}`);
	}

	const candidate = data.candidates?.[0];

	// Debug logging
	console.debug(`[Gemini] Response finishReason: ${candidate?.finishReason}`);
	console.debug(`[Gemini] Response text length: ${candidate?.content?.parts?.[0]?.text?.length || 0} chars`);
	if (data.usageMetadata) {
		console.debug(`[Gemini] Usage: prompt=${data.usageMetadata.promptTokenCount}, output=${data.usageMetadata.candidatesTokenCount}, total=${data.usageMetadata.totalTokenCount}`);
	}

	if (!candidate?.content?.parts?.[0]?.text) {
		if (candidate?.finishReason === 'SAFETY') {
			throw createError('api_error', 'Gemini extraction blocked by safety filters. Try distinct content.');
		}
		throw createError('api_error', 'Empty response from Gemini API');
	}

	return candidate.content.parts[0].text;
}

async function callOllama(host: string, model: string, prompt: string): Promise<string> {
	// Normalize host URL
	const baseUrl = host.replace(/\/+$/, '');

	const res = await requestUrl({
		url: `${baseUrl}/api/generate`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: model,
			prompt: prompt,
			stream: false,
			options: {
				temperature: 0.3,
			},
		}),
	});

	const data = res.json;
	if (!data.response) {
		throw createError('api_error', 'Empty response from Ollama API');
	}
	return data.response;
}

// ============================================
// Embedding Functions
// ============================================

export interface EmbeddingOptions {
	provider: EmbeddingProvider;
	apiKey: string;
	model: string;
	ollamaHost?: string;
}

/**
 * Get embeddings for a batch of texts.
 * Returns an array of Float32Arrays, one per input text.
 */
export async function getEmbeddings(
	options: EmbeddingOptions,
	texts: string[]
): Promise<Float32Array[]> {
	const { provider, apiKey, model, ollamaHost } = options;

	// Ollama doesn't need an API key
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
			case 'ollama':
				return await callOllamaEmbeddings(ollamaHost || 'http://localhost:11434', model, texts);
			default:
				throw createError('config_error', `Unknown embedding provider: ${provider as string}`);
		}
	} catch (e) {
		if (e instanceof Error && 'type' in e) {
			throw e; // Already an ExtractionError
		}
		throw handleApiError(e, provider);
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
		ollamaHost: settings.ollamaHost,
	};
}

async function callOpenAIEmbeddings(apiKey: string, model: string, texts: string[]): Promise<Float32Array[]> {
	const res = await requestUrl({
		url: 'https://api.openai.com/v1/embeddings',
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model: model,
			input: texts,
		}),
	});

	const data = res.json;
	if (!data.data || !Array.isArray(data.data)) {
		throw createError('api_error', 'Invalid response from OpenAI embeddings API');
	}

	// Sort by index to ensure correct order
	const sorted = data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index);
	return sorted.map((item: { embedding: number[] }) => new Float32Array(item.embedding));
}

async function callGeminiEmbeddings(apiKey: string, model: string, texts: string[]): Promise<Float32Array[]> {
	// Gemini uses a different API structure - batch embed
	const res = await requestUrl({
		url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${apiKey}`,
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			requests: texts.map(text => ({
				model: `models/${model}`,
				content: { parts: [{ text }] },
			})),
		}),
	});

	const data = res.json;

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

	// Ollama's embedding API processes one text at a time
	for (const text of texts) {
		const res = await requestUrl({
			url: `${baseUrl}/api/embeddings`,
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: model,
				prompt: text,
			}),
		});

		const data = res.json;
		if (!data.embedding || !Array.isArray(data.embedding)) {
			throw createError('api_error', 'Invalid response from Ollama embeddings API');
		}

		results.push(new Float32Array(data.embedding));
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

		const offset = headerSize + i * embeddingSize;
		const embeddingView = new Float32Array(buffer, offset, dimensions);
		embeddingView.set(embedding.slice(0, dimensions));
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
		const response = await callLLMProvider(options, prompt);
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
 * Extract JSON string from LLM response, handling markdown code blocks.
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
	const rawEntities = (parsed.entities || parsed.nodes || []) as Record<string, unknown>[];
	const nodes: RawExtractionNode[] = [];
	let idCounter = 1;

	for (const entity of rawEntities) {
		if (!entity || typeof entity !== 'object') continue;

		// Get name from either direct property or nested properties
		const props = entity.properties as Record<string, unknown> | undefined;
		const name = entity.name || props?.name;
		if (!name || typeof name !== 'string') continue;

		// Get entity type - try entity_type, then label, default to CONCEPT
		let entityType: EntityType = 'CONCEPT';
		const rawType = entity.entity_type || entity.entityType || entity.label;
		if (rawType && typeof rawType === 'string') {
			const upperType = rawType.toUpperCase();
			if (isValidEntityType(upperType)) {
				entityType = upperType;
			}
		}

		// Get description
		const description = entity.description || props?.description;

		nodes.push({
			id: toStringId(entity.id, String(idCounter++)),
			entityType,
			properties: {
				name: name.trim(),
				description: typeof description === 'string' ? description : undefined,
			}
		});
	}

	return nodes;
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
 * Convert legacy relationship type to verb.
 */
const LEGACY_TYPE_TO_VERB: Record<string, string> = {
	'HAS_PART': 'contains',
	'LEADS_TO': 'leads to',
	'ACTED_ON': 'acts on',
	'CITES': 'cites',
	'RELATED_TO': 'relates to',
};

/**
 * Parse relationships from parsed JSON object.
 * Resolves entity names to IDs using the provided name-to-id map.
 */
function parseRelationships(
	parsed: Record<string, unknown>,
	nodes: RawExtractionNode[],
	nameToId: Map<string, string>
): RawExtractionRelationship[] {
	const rawRelationships = (parsed.relationships || []) as Record<string, unknown>[];
	const relationships: RawExtractionRelationship[] = [];

	for (const rel of rawRelationships) {
		if (!rel || typeof rel !== 'object') continue;

		const sourceId = resolveId(rel.source, nodes, nameToId);
		const targetId = resolveId(rel.target, nodes, nameToId);

		if (!sourceId || !targetId) continue;

		// Get relationship verb - try relationship, then type with conversion
		let relationship = typeof rel.relationship === 'string' ? rel.relationship : '';
		if (!relationship && rel.type !== undefined && rel.type !== null) {
			const typeStr = typeof rel.type === 'string' ? rel.type : '';
			relationship = LEGACY_TYPE_TO_VERB[typeStr.toUpperCase()] || typeStr;
		}
		if (!relationship) {
			relationship = 'relates to';
		}

		const props = rel.properties as Record<string, unknown> | undefined;
		const detail = rel.description || props?.detail;

		relationships.push({
			source: sourceId,
			target: targetId,
			relationship: relationship.toLowerCase(),
			properties: {
				detail: typeof detail === 'string' ? detail : undefined,
			}
		});
	}

	return relationships;
}

/**
 * Parse LLM response into OntologyExtractionResult.
 * Handles both new schema (entities/relationships) and legacy schema (nodes/relationships).
 */
function parseOntologyResponse(response: string): OntologyExtractionResult {
	const jsonStr = extractJsonFromResponse(response);

	try {
		const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

		// Parse entities
		const nodes = parseEntities(parsed);

		// Build name-to-id map for relationship resolution
		const nameToId = new Map<string, string>();
		for (const node of nodes) {
			nameToId.set(node.properties.name.toLowerCase(), node.id);
		}

		// Parse relationships
		const relationships = parseRelationships(parsed, nodes, nameToId);

		return { nodes, relationships };
	} catch {
		console.error('Failed to parse LLM response:', response);
		throw createError('parse_error', 'Failed to parse extraction result from LLM', response.slice(0, 200));
	}
}
