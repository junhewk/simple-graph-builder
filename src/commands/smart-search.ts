/**
 * Smart Search command - LLM-powered natural language search over the knowledge graph.
 * Uses tool calls to let the LLM explore the graph interactively.
 */

import { getAdapter, runToolLoop } from '../extraction/providers/index';
import SimpleGraphBuilderPlugin from '../main';
import { buildSmartSearchSystemPrompt, getSmartSearchTools } from '../extraction/prompts';
import { executeToolCall, ToolCall } from '../graph/tools';
import { getSmartSearchConfig } from '../settings';

// ============================================
// Types
// ============================================

interface SmartSearchResult {
	answer: string;
	relevantNodes: Array<{ name: string; entityType: string; relevance: string }>;
	sourceNotes: Array<{ path: string; title: string; relevance: string }>;
}

// ============================================
// Smart Search Implementation
// ============================================

/**
 * Execute a smart search query using LLM with tool calls.
 */
export async function executeSmartSearch(
	plugin: SimpleGraphBuilderPlugin,
	query: string,
	onProgress?: (status: string) => void
): Promise<SmartSearchResult> {
	const config = getSmartSearchConfig(plugin.settings);

	// Check API configuration
	if (config.provider !== 'ollama' && !config.apiKey) {
		throw new Error('API key not configured. Please set your API key in settings.');
	}

	const systemPrompt = buildSmartSearchSystemPrompt();
	const tools = getSmartSearchTools();

	onProgress?.('Analyzing question...');

	const creds = {
		apiKey: config.apiKey,
		ollamaHost: config.ollamaHost,
		localApiStyle: config.localApiStyle,
	};

	const loop = await runToolLoop({
		adapter: getAdapter(config.provider, creds),
		request: {
			model: config.model,
			system: systemPrompt,
			tools,
			effort: config.effort,
			maxOutputTokens: config.maxOutputTokens,
		},
		creds,
		initialUserText: query,
		onProgress,
		execute: (call) =>
			executeToolCall(plugin.graphCache, {
				name: call.name as ToolCall['name'],
				arguments: (call.arguments ?? {}) as Record<string, unknown>,
			}).result,
	});

	if (loop.exhausted) {
		return {
			answer: 'Search took too long. Please try a more specific query.',
			relevantNodes: [],
			sourceNotes: [],
		};
	}

	onProgress?.('Generating answer...');
	return toSearchResult(loop.text);
}

/**
 * The model is asked for a JSON answer envelope but does not always produce
 * one, so fall back to treating the reply as plain prose.
 */
function toSearchResult(text: string): SmartSearchResult {
	try {
		return parseSmartSearchResponse(text);
	} catch {
		return {
			answer: text || 'No answer generated.',
			relevantNodes: [],
			sourceNotes: [],
		};
	}
}

function parseSmartSearchResponse(response: string): SmartSearchResult {
	// Try to extract JSON from response
	let jsonStr = response.trim();

	// Handle markdown code blocks
	const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (codeBlockMatch) {
		jsonStr = codeBlockMatch[1].trim();
	}

	// Try to find JSON object
	if (!jsonStr.startsWith('{')) {
		const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonStr = jsonMatch[0];
		}
	}

	try {
		const parsed = JSON.parse(jsonStr);

		return {
			answer: parsed.answer || response,
			relevantNodes: Array.isArray(parsed.relevantNodes) ? parsed.relevantNodes : [],
			sourceNotes: Array.isArray(parsed.sourceNotes) ? parsed.sourceNotes : [],
		};
	} catch {
		// If JSON parsing fails, return the raw text as the answer
		return {
			answer: response,
			relevantNodes: [],
			sourceNotes: [],
		};
	}
}

// ============================================
// Command Entry Point
// ============================================

/**
 * Open the smart search modal (will be implemented in smart-search-modal.ts).
 * This is a simple wrapper for now.
 */
export async function openSmartSearch(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	// Import dynamically to avoid circular dependencies
	const { SmartSearchModal } = await import('../ui/smart-search-modal');
	new SmartSearchModal(plugin.app, plugin).open();
}
