import { Settings } from './types';
import { CURRENT_SETTINGS_VERSION } from './settings';

/**
 * Stored model IDs are rewritten to their current equivalents.
 *
 * Order matters: the narrower pattern in each family must come first, or the
 * general rule swallows it (`gemini-2.5-flash-lite` would become
 * `gemini-3.6-flash` rather than `gemini-3.5-flash-lite`).
 *
 * Ollama models are deliberately absent — those tags name models the user has
 * actually pulled to disk, and rewriting one points at something that isn't
 * there.
 */
const MODEL_MIGRATIONS: [RegExp, string][] = [
	// Anthropic. Only Sonnet 5 and Haiku 4.5 are offered, so Opus lands on Sonnet 5.
	[/^claude-(3-5-haiku|3-haiku|haiku-)/, 'claude-haiku-4-5'],
	[/^claude-/, 'claude-sonnet-5'],

	// OpenAI. Small/cheap tiers land on the mini model, everything else on Luna.
	[/^(gpt-.*-(mini|nano)|gpt-.*-(mini|nano)-.*|o\d-mini)/, 'gpt-5.4-mini'],
	[/^(gpt-|o\d)/, 'gpt-5.6-luna'],

	// Gemini. Lite tier keeps its tier.
	[/^gemini-.*(lite|flash-8b)/, 'gemini-3.5-flash-lite'],
	[/^gemini-/, 'gemini-3.6-flash'],
];

/** Embedding models are versioned separately from chat models. */
const EMBEDDING_MIGRATIONS: [RegExp, string][] = [
	// text-embedding-004 was shut down 2026-01-14. The @768 variant keeps the
	// same vector width, so stored embeddings stay valid.
	[/^text-embedding-004$/, 'gemini-embedding-001@768'],
	[/^embedding-001$/, 'gemini-embedding-001@768'],
];

const CHAT_MODEL_KEYS = [
	'claudeModel',
	'openaiModel',
	'geminiModel',
	'smartSearchClaudeModel',
	'smartSearchOpenaiModel',
	'smartSearchGeminiModel',
] as const;

function migrateId(value: string, rules: [RegExp, string][]): string {
	for (const [pattern, replacement] of rules) {
		if (pattern.test(value)) return replacement;
	}
	return value;
}

export interface MigrationResult {
	settings: Settings;
	changed: boolean;
	notes: string[];
}

/**
 * Bring persisted settings up to the current version.
 *
 * `loadSettings` merges stored settings over DEFAULT_SETTINGS, which means a
 * `settingsVersion` absent from disk is filled in from the defaults and looks
 * current. The stored version must therefore be read from the raw data and
 * passed in, not taken off the merged object.
 */
export function migrateSettings(settings: Settings, storedVersion: number): MigrationResult {
	const notes: string[] = [];
	const next = { ...settings };

	// v1: extractionMode was renamed.
	const mode = next.extractionMode as string;
	if (mode === 'simple') {
		next.extractionMode = 'standard';
		notes.push('extractionMode: simple → standard');
	} else if (mode === 'advanced' || mode === 'maximum') {
		next.extractionMode = 'thorough';
		notes.push(`extractionMode: ${mode} → thorough`);
	}

	// v2: July 2026 model IDs. Version-gated so a later deliberate choice of an
	// older model is not clobbered on every load.
	if (storedVersion < 2) {
		for (const key of CHAT_MODEL_KEYS) {
			const before = next[key];
			if (!before) continue;
			const after = migrateId(before, MODEL_MIGRATIONS);
			if (after !== before) {
				next[key] = after;
				notes.push(`${key}: ${before} → ${after}`);
			}
		}

		const beforeEmbedding = next.embeddingModel;
		if (beforeEmbedding) {
			const afterEmbedding = migrateId(beforeEmbedding, EMBEDDING_MIGRATIONS);
			if (afterEmbedding !== beforeEmbedding) {
				next.embeddingModel = afterEmbedding;
				notes.push(`embeddingModel: ${beforeEmbedding} → ${afterEmbedding}`);
			}
		}
	}

	next.settingsVersion = CURRENT_SETTINGS_VERSION;

	const changed = notes.length > 0 || storedVersion !== CURRENT_SETTINGS_VERSION;
	return { settings: next, changed, notes };
}
