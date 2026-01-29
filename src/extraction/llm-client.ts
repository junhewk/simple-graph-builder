import { ApiProvider, EmbeddingProvider, OntologyExtractionResult, Settings, RelationshipType, isValidRelationshipType } from '../types';
import { requestUrl, Vault } from 'obsidian';
import { getEmbeddingDimensions } from '../settings';

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
	const { provider, apiKey, model, ollamaHost } = options;

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
			throw createError('config_error', `Unknown provider: ${provider}`);
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
	console.log(`[Gemini] Calling model: ${model}, prompt length: ${prompt.length} chars`);

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
	console.log(`[Gemini] Response finishReason: ${candidate?.finishReason}`);
	console.log(`[Gemini] Response text length: ${candidate?.content?.parts?.[0]?.text?.length || 0} chars`);
	if (data.usageMetadata) {
		console.log(`[Gemini] Usage: prompt=${data.usageMetadata.promptTokenCount}, output=${data.usageMetadata.candidatesTokenCount}, total=${data.usageMetadata.totalTokenCount}`);
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
				throw createError('config_error', `Unknown embedding provider: ${provider}`);
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
				await vault.delete(existingFile);
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
		console.log('No embeddings file found, starting fresh');
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
 * Parse LLM response into OntologyExtractionResult.
 * Validates relationship types and normalizes the structure.
 */
function parseOntologyResponse(response: string): OntologyExtractionResult {
	// Extract JSON from response (handle markdown code blocks)
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

	try {
		const parsed = JSON.parse(jsonStr);

		// Validate and normalize nodes
		const nodes = Array.isArray(parsed.nodes)
			? parsed.nodes
				.filter((n: unknown) => {
					if (!n || typeof n !== 'object') return false;
					const node = n as Record<string, unknown>;
					return node.id && node.label &&
						node.properties &&
						typeof (node.properties as Record<string, unknown>).name === 'string';
				})
				.map((n: Record<string, unknown>) => ({
					id: String(n.id),
					label: String(n.label),
					properties: {
						name: String((n.properties as Record<string, unknown>).name),
						...Object.fromEntries(
							Object.entries(n.properties as Record<string, unknown>)
								.filter(([k]: [string, unknown]) => k !== 'name')
						)
					}
				}))
			: [];

		// Validate and normalize relationships
		const relationships = Array.isArray(parsed.relationships)
			? parsed.relationships
				.filter((r: unknown) => {
					if (!r || typeof r !== 'object') return false;
					const rel = r as Record<string, unknown>;
					return rel.source && rel.target && rel.type &&
						isValidRelationshipType(String(rel.type));
				})
				.map((r: Record<string, unknown>) => ({
					source: String(r.source),
					target: String(r.target),
					type: String(r.type) as RelationshipType,
					properties: {
						detail: r.properties && typeof (r.properties as Record<string, unknown>).detail === 'string'
							? String((r.properties as Record<string, unknown>).detail)
							: 'related',
						...Object.fromEntries(
							r.properties && typeof r.properties === 'object'
								? Object.entries(r.properties as Record<string, unknown>)
									.filter(([k]: [string, unknown]) => k !== 'detail')
								: []
						)
					}
				}))
			: [];

		// Log warning for invalid relationship types that were filtered out
		const invalidRelTypes = Array.isArray(parsed.relationships)
			? (parsed.relationships as Record<string, unknown>[])
				.filter(r => r.type && !isValidRelationshipType(String(r.type)))
				.map(r => r.type)
			: [];
		if (invalidRelTypes.length > 0) {
			console.warn('Filtered out invalid relationship types:', [...new Set(invalidRelTypes)]);
		}

		return { nodes, relationships };
	} catch (e) {
		console.error('Failed to parse LLM response:', response);
		throw createError('parse_error', 'Failed to parse extraction result from LLM', response.slice(0, 200));
	}
}
