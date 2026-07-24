import { Settings } from './types';
import { resolveModelConfig, ResolvedModel } from './extraction/providers/models';
import { DEFAULT_EFFORT } from './extraction/providers/effort';

/**
 * Bumped whenever a migration step is added. See src/settings-migration.ts.
 * 1 = pre-versioning (extractionMode rename only)
 * 2 = July 2026 model IDs + effort levels
 */
export const CURRENT_SETTINGS_VERSION = 2;

// The model catalog and the provider/model/key resolver now live with the
// provider adapters. Re-exported here so existing importers keep working.
export {
	MODEL_OPTIONS,
	supportsToolCalling,
	getLimitedToolSupportModels,
	resolveModelConfig,
} from './extraction/providers/models';

/**
 * Get the effective Smart Search configuration.
 */
export function getSmartSearchConfig(settings: Settings): ResolvedModel {
	return resolveModelConfig(settings, 'smartSearch');
}

export const DEFAULT_SETTINGS: Settings = {
	apiProvider: 'claude',
	apiKey: '',
	claudeModel: 'claude-sonnet-5',
	openaiModel: 'gpt-5.4-mini',
	geminiModel: 'gemini-3.6-flash',
	ollamaModel: 'gpt-oss:20b',
	ollamaHost: 'http://localhost:11434',
	localApiStyle: 'ollama',
	extractionMode: 'standard',
	extractionEffort: DEFAULT_EFFORT,
	autoAnalyzeOnSave: false,
	// Smart Search model settings
	useSeparateSmartSearchModel: false,
	smartSearchProvider: 'claude',
	smartSearchClaudeModel: 'claude-sonnet-5',
	smartSearchOpenaiModel: 'gpt-5.6-luna',
	smartSearchGeminiModel: 'gemini-3.6-flash',
	smartSearchOllamaModel: 'qwen3:32b',
	smartSearchEffort: DEFAULT_EFFORT,
	// View settings
	openGraphInMain: false,
	graphMinDegree: 0,
	// Embedding-based resolution (opt-in)
	enableEmbeddings: false,
	embeddingProvider: 'openai',
	embeddingApiKey: '',
	embeddingModel: 'text-embedding-3-small',
	embeddingHost: '',
	embeddingLocalApiStyle: 'ollama',
	resolutionThresholdHigh: 0.90,
	resolutionThresholdLow: 0.80,
	enableLLMVerification: true,
	settingsVersion: CURRENT_SETTINGS_VERSION,
};

// Default embedding dimensions (OpenAI text-embedding-3-small)
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

// Embedding model options per provider
export const EMBEDDING_MODEL_OPTIONS = {
	openai: [
		{ id: 'text-embedding-3-small', name: 'text-embedding-3-small (1536 dims)', dimensions: 1536 },
		{ id: 'text-embedding-3-large', name: 'text-embedding-3-large (3072 dims)', dimensions: 3072 },
		{ id: 'text-embedding-ada-002', name: 'text-embedding-ada-002 (1536 dims)', dimensions: 1536 },
	],
	gemini: [
		// text-embedding-004 was shut down 2026-01-14. The @768 variant is the
		// default because it matches the old vector width — so a migrated
		// install keeps its stored embeddings — and because 3072 dims is 12 KB
		// per node, which is 60 MB for a 5,000-node vault inside a synced
		// .obsidian folder.
		{
			id: 'gemini-embedding-001@768',
			name: 'gemini-embedding-001 (768 dims)',
			dimensions: 768,
			apiModel: 'gemini-embedding-001',
			outputDimensionality: 768,
		},
		{
			id: 'gemini-embedding-001@1536',
			name: 'gemini-embedding-001 (1536 dims)',
			dimensions: 1536,
			apiModel: 'gemini-embedding-001',
			outputDimensionality: 1536,
		},
		{
			id: 'gemini-embedding-001',
			name: 'gemini-embedding-001 (3072 dims, largest)',
			dimensions: 3072,
			apiModel: 'gemini-embedding-001',
		},
	],
	ollama: [
		{ id: 'nomic-embed-text', name: 'nomic-embed-text (768 dims)', dimensions: 768 },
		{ id: 'mxbai-embed-large', name: 'mxbai-embed-large (1024 dims)', dimensions: 1024 },
		{ id: 'all-minilm', name: 'all-minilm (384 dims)', dimensions: 384 },
	],
};

interface EmbeddingModelOption {
	id: string;
	name: string;
	dimensions: number;
	/** Wire model name, when it differs from the catalogue id. */
	apiModel?: string;
	/** Matryoshka truncation length, when narrower than the model's native width. */
	outputDimensionality?: number;
}

function findEmbeddingModel(provider: string, model: string): EmbeddingModelOption | undefined {
	const providerOptions = EMBEDDING_MODEL_OPTIONS[
		provider as keyof typeof EMBEDDING_MODEL_OPTIONS
	] as EmbeddingModelOption[] | undefined;
	return providerOptions?.find(m => m.id === model);
}

/**
 * Get embedding dimensions for a given provider and model.
 */
export function getEmbeddingDimensions(provider: string, model: string): number {
	return findEmbeddingModel(provider, model)?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
}

/**
 * Catalogue ids can encode a truncation width (`gemini-embedding-001@768`),
 * which is not a model name the API knows. Resolve to what goes on the wire.
 */
export function getEmbeddingRequestConfig(
	provider: string,
	model: string
): { apiModel: string; outputDimensionality?: number } {
	const option = findEmbeddingModel(provider, model);
	return {
		apiModel: option?.apiModel ?? model,
		outputDimensionality: option?.outputDimensionality,
	};
}
