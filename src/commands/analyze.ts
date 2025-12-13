import { Notice, MarkdownView, TFile } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { loadHashes, saveHashes, computeHash, hasNoteChanged, updateNoteHash, removeNoteHash, clearHashes } from '../graph/hashes';
import { mergeExtractionIntoCache, mergeInternalLinksIntoCache, removeNoteFromCache } from '../graph/merge';
import { buildExtractionPrompt, truncateContent } from '../extraction/prompts';
import { extractOntology, settingsToExtractionOptions, ExtractionError } from '../extraction/llm-client';

// Track if vault analysis is running (to prevent multiple concurrent runs)
let isVaultAnalysisRunning = false;
let vaultAnalysisCancelled = false;

export async function analyzeCurrentNote(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView?.file) {
		new Notice('No active note to analyze');
		return;
	}

	const file = activeView.file;
	const content = await plugin.app.vault.read(file);

	// Check if content is too short
	if (content.trim().length < 50) {
		new Notice('Note is too short to analyze');
		return;
	}

	// Check if note has changed
	const hashes = await loadHashes(plugin);
	const currentHash = computeHash(content);

	if (!hasNoteChanged(hashes, file.path, currentHash)) {
		new Notice('Note has not changed since last analysis');
		return;
	}

	// Check API configuration
	const { apiProvider, apiKey, ollamaModel } = plugin.settings;
	if (apiProvider !== 'ollama' && !apiKey) {
		new Notice('Please configure your API key in settings');
		return;
	}
	if (apiProvider === 'ollama' && !ollamaModel) {
		new Notice('Please configure your Ollama model in settings');
		return;
	}

	// Show loading notice (timeout 0 = persistent until hidden)
	const loadingNotice = new Notice(`Analyzing "${file.basename}"...`, 0);

	try {
		// Get existing node names for context (O(1) via cache)
		const existingNodeNames = plugin.graphCache.getExistingNodeNames();

		// Build prompt and call LLM
		const truncatedContent = truncateContent(content);
		const prompt = buildExtractionPrompt(truncatedContent, existingNodeNames, plugin.settings.extractionMode || 'simple');
		const options = settingsToExtractionOptions(plugin.settings);
		const result = await extractOntology(options, prompt);

		// Hide loading notice
		loadingNotice.hide();

		// Merge results into graph cache (indexed, debounced save)
		const { nodesAdded, relationshipsAdded } = mergeExtractionIntoCache(
			plugin.graphCache,
			file.path,
			result
		);

		// Process internal links ([[wikilinks]])
		const linksAdded = mergeInternalLinksIntoCache(plugin.graphCache, plugin.app, file, content);

		// Update hash
		const updatedHashes = updateNoteHash(hashes, file.path, currentHash);
		await saveHashes(plugin, updatedHashes);

		// Build success message
		const parts: string[] = [];
		if (nodesAdded > 0) {
			parts.push(`${nodesAdded} nodes`);
		}
		if (relationshipsAdded > 0) {
			parts.push(`${relationshipsAdded} relationships`);
		}
		if (linksAdded > 0) {
			parts.push(`${linksAdded} links`);
		}

		// Also show total extracted (even if merged with existing)
		const totalNodes = result.nodes.length;
		const totalRels = result.relationships.length;

		if (parts.length > 0) {
			new Notice(`Added: ${parts.join(', ')}\n(Extracted: ${totalNodes} nodes, ${totalRels} relationships)`);
		} else if (totalNodes > 0 || totalRels > 0) {
			new Notice(`Extracted ${totalNodes} nodes, ${totalRels} relationships (all merged with existing)`);
		} else {
			new Notice('No entities or relationships found in this note');
		}

		// Update status bar
		plugin.updateStatusBar();
	} catch (error) {
		// Hide loading notice
		loadingNotice.hide();

		console.error('Analysis failed:', error);
		const err = error as Error & ExtractionError;

		if (err.type === 'rate_limit') {
			new Notice('Rate limit exceeded. Please wait a moment and try again.', 5000);
		} else if (err.type === 'config_error') {
			new Notice(err.message, 5000);
		} else if (err.type === 'parse_error') {
			new Notice('Failed to parse LLM response. Please try again.', 5000);
		} else if (err.type === 'api_error') {
			new Notice(`API error: ${err.message}`, 5000);
		} else {
			new Notice(`Analysis failed: ${err.message}`, 5000);
		}
	}
}

/**
 * Remove the current note from the knowledge graph.
 */
export async function removeCurrentNoteFromGraph(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
	if (!activeView?.file) {
		new Notice('No active note');
		return;
	}

	const file = activeView.file;
	const { nodesRemoved, edgesRemoved } = removeNoteFromCache(plugin.graphCache, file.path);

	if (nodesRemoved > 0 || edgesRemoved > 0) {
		// Also remove the hash so it can be re-analyzed
		const hashes = await loadHashes(plugin);
		const updatedHashes = removeNoteHash(hashes, file.path);
		await saveHashes(plugin, updatedHashes);

		new Notice(`Removed "${file.basename}" from graph (${nodesRemoved} nodes, ${edgesRemoved} edges)`);
		plugin.updateStatusBar();
	} else {
		new Notice('This note is not in the graph');
	}
}

/**
 * Clear all graph data and analysis history.
 */
export async function clearAllGraphData(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	plugin.graphCache.clear();
	await plugin.graphCache.flush();
	await clearHashes(plugin);
	new Notice('All graph data cleared');
	plugin.updateStatusBar();
}

/**
 * Analyze a single file (used by vault analysis and auto-analysis).
 * Returns true if analysis was successful, false otherwise.
 */
export async function analyzeFile(
	plugin: SimpleGraphBuilderPlugin,
	file: TFile,
	hashes: { hashes: Array<{ path: string; hash: string; analyzedAt: number }> },
	options?: { skipUnchanged?: boolean }
): Promise<{ success: boolean; skipped: boolean; nodesAdded: number; relationshipsAdded: number; error?: string }> {
	const { skipUnchanged = true } = options ?? {};

	try {
		const content = await plugin.app.vault.read(file);

		// Check if content is too short
		if (content.trim().length < 50) {
			return { success: false, skipped: true, nodesAdded: 0, relationshipsAdded: 0 };
		}

		// Check if note has changed
		const currentHash = computeHash(content);
		if (skipUnchanged && !hasNoteChanged(hashes, file.path, currentHash)) {
			return { success: false, skipped: true, nodesAdded: 0, relationshipsAdded: 0 };
		}

		// Get existing node names for context
		const existingNodeNames = plugin.graphCache.getExistingNodeNames();

		// Build prompt and call LLM
		const truncatedContent = truncateContent(content);
		const prompt = buildExtractionPrompt(truncatedContent, existingNodeNames, plugin.settings.extractionMode || 'simple');
		const extractionOptions = settingsToExtractionOptions(plugin.settings);
		const result = await extractOntology(extractionOptions, prompt);

		// Merge results into graph cache
		const { nodesAdded, relationshipsAdded } = mergeExtractionIntoCache(
			plugin.graphCache,
			file.path,
			result
		);

		// Process internal links ([[wikilinks]])
		mergeInternalLinksIntoCache(plugin.graphCache, plugin.app, file, content);

		// Update hash in the passed hashes object
		const existingIndex = hashes.hashes.findIndex(h => h.path === file.path);
		const hashRecord = { path: file.path, hash: currentHash, analyzedAt: Date.now() };
		if (existingIndex >= 0) {
			hashes.hashes[existingIndex] = hashRecord;
		} else {
			hashes.hashes.push(hashRecord);
		}

		return { success: true, skipped: false, nodesAdded, relationshipsAdded };
	} catch (error) {
		const err = error as Error & ExtractionError;
		return { success: false, skipped: false, nodesAdded: 0, relationshipsAdded: 0, error: err.message };
	}
}

/**
 * Check if vault analysis is currently running.
 */
export function isAnalyzingVault(): boolean {
	return isVaultAnalysisRunning;
}

/**
 * Cancel the current vault analysis.
 */
export function cancelVaultAnalysis(): void {
	vaultAnalysisCancelled = true;
}

/**
 * Analyze all markdown files in the vault.
 * Shows progress and handles rate limiting.
 */
export async function analyzeEntireVault(
	plugin: SimpleGraphBuilderPlugin,
	onProgress?: (current: number, total: number, currentFile: string) => void
): Promise<{ analyzed: number; skipped: number; errors: number; nodesAdded: number; relationshipsAdded: number }> {
	if (isVaultAnalysisRunning) {
		new Notice('Vault analysis is already running');
		return { analyzed: 0, skipped: 0, errors: 0, nodesAdded: 0, relationshipsAdded: 0 };
	}

	// Check API configuration
	const { apiProvider, apiKey, ollamaModel } = plugin.settings;
	if (apiProvider !== 'ollama' && !apiKey) {
		new Notice('Please configure your API key in settings');
		return { analyzed: 0, skipped: 0, errors: 0, nodesAdded: 0, relationshipsAdded: 0 };
	}
	if (apiProvider === 'ollama' && !ollamaModel) {
		new Notice('Please configure your Ollama model in settings');
		return { analyzed: 0, skipped: 0, errors: 0, nodesAdded: 0, relationshipsAdded: 0 };
	}

	isVaultAnalysisRunning = true;
	vaultAnalysisCancelled = false;

	// Get all markdown files
	const files = plugin.app.vault.getMarkdownFiles();
	const total = files.length;
	let analyzed = 0;
	let skipped = 0;
	let errors = 0;
	let totalNodesAdded = 0;
	let totalRelationshipsAdded = 0;

	// Load hashes once
	const hashes = await loadHashes(plugin);

	const progressNotice = new Notice(`Analyzing vault: 0/${total}...`, 0);

	try {
		for (let i = 0; i < files.length; i++) {
			if (vaultAnalysisCancelled) {
				progressNotice.hide();
				new Notice(`Vault analysis cancelled.\nAnalyzed: ${analyzed}, Nodes: ${totalNodesAdded}, Relationships: ${totalRelationshipsAdded}`);
				break;
			}

			const file = files[i];

			// Update progress
			progressNotice.setMessage(`Analyzing vault: ${i + 1}/${total}\n${file.basename}`);
			onProgress?.(i + 1, total, file.basename);

			const result = await analyzeFile(plugin, file, hashes);

			if (result.success) {
				analyzed++;
				totalNodesAdded += result.nodesAdded;
				totalRelationshipsAdded += result.relationshipsAdded;
			} else if (result.skipped) {
				skipped++;
			} else {
				errors++;
				console.error(`Failed to analyze ${file.path}:`, result.error);
			}

			// Small delay to avoid rate limiting (adjust as needed)
			if (result.success && i < files.length - 1) {
				await sleep(500); // 500ms between API calls
			}
		}

		// Save hashes after all analysis
		await saveHashes(plugin, hashes);
		await plugin.graphCache.flush();

		progressNotice.hide();

		if (!vaultAnalysisCancelled) {
			new Notice(
				`Vault analysis complete!\n` +
				`Analyzed: ${analyzed}, Skipped: ${skipped}, Errors: ${errors}\n` +
				`Added: ${totalNodesAdded} nodes, ${totalRelationshipsAdded} relationships`
			);
		}

		// Update status bar
		plugin.updateStatusBar();
	} finally {
		isVaultAnalysisRunning = false;
		vaultAnalysisCancelled = false;
	}

	return { analyzed, skipped, errors, nodesAdded: totalNodesAdded, relationshipsAdded: totalRelationshipsAdded };
}

/**
 * Analyze a file if auto-analysis is enabled.
 * Called when a file is modified/created.
 */
export async function autoAnalyzeFile(plugin: SimpleGraphBuilderPlugin, file: TFile): Promise<void> {
	if (!plugin.settings.autoAnalyzeOnSave) {
		return;
	}

	// Check API configuration
	const { apiProvider, apiKey, ollamaModel } = plugin.settings;
	if (apiProvider !== 'ollama' && !apiKey) {
		return; // Silently skip if not configured
	}
	if (apiProvider === 'ollama' && !ollamaModel) {
		return;
	}

	// Don't auto-analyze during vault analysis
	if (isVaultAnalysisRunning) {
		return;
	}

	const hashes = await loadHashes(plugin);
	const loadingNotice = new Notice(`Auto-analyzing "${file.basename}"...`, 0);

	try {
		const result = await analyzeFile(plugin, file, hashes);

		loadingNotice.hide();

		if (result.success) {
			await saveHashes(plugin, hashes);
			new Notice(`Auto-analyzed "${file.basename}" (+${result.nodesAdded} nodes, +${result.relationshipsAdded} rels)`);
			plugin.updateStatusBar();
		}
		// Silently ignore skipped/errors for auto-analysis
	} catch (error) {
		loadingNotice.hide();
		console.error('Auto-analysis failed:', error);
	}
}

// Helper function
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
