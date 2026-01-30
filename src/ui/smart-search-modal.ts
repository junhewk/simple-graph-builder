/**
 * Smart Search Modal - Natural language search UI with AI-generated answers.
 */

import { App, Modal, Notice } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { executeSmartSearch } from '../commands/smart-search';
import { supportsToolCalling } from '../settings';
import { getEntityTypeColor } from '../types';

export class SmartSearchModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private inputEl: HTMLTextAreaElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private statusEl: HTMLElement | null = null;
	private isSearching = false;

	constructor(app: App, plugin: SimpleGraphBuilderPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('smart-search-modal sgb-smart-search-content');

		// Title
		contentEl.createEl('h2', { text: 'Smart search', cls: 'sgb-smart-search-title' });

		contentEl.createEl('p', {
			cls: 'sgb-smart-search-desc',
			text: 'Ask a question about your knowledge graph. The AI will explore connections and provide an answer with sources.',
		});

		// Input area
		const inputContainer = contentEl.createDiv({ cls: 'sgb-smart-search-input-container' });

		this.inputEl = inputContainer.createEl('textarea', {
			cls: 'smart-search-input sgb-smart-search-textarea',
			attr: {
				placeholder: 'e.g., "What methods did we use for the project?" or "Who is connected to Alice?"',
				rows: '3',
			},
		});

		// Search button
		const buttonContainer = contentEl.createDiv({ cls: 'sgb-smart-search-btn-container' });

		const searchBtn = buttonContainer.createEl('button', {
			cls: 'smart-search-btn mod-cta',
			text: 'Search',
		});

		// Check if model supports tool calling
		const toolSupported = supportsToolCalling(this.plugin.settings);
		if (!toolSupported) {
			searchBtn.disabled = true;
			searchBtn.addClass('sgb-btn-disabled');

			const warningEl = contentEl.createDiv({ cls: 'sgb-smart-search-warning' });
			warningEl.createEl('strong', { text: 'Model not supported:' });
			warningEl.appendText(' The current model (');
			warningEl.createEl('code', { text: this.getCurrentModelName() });
			warningEl.appendText(') has limited tool calling support.');
			warningEl.createEl('br');
			warningEl.appendText('Smart Search requires tool calling. Please switch to a compatible model in settings.');
		}

		// Status indicator
		this.statusEl = contentEl.createDiv({ cls: 'sgb-smart-search-status' });

		// Results area
		this.resultsEl = contentEl.createDiv({ cls: 'smart-search-results' });

		// Event handlers
		searchBtn.addEventListener('click', () => void this.performSearch());
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				void this.performSearch();
			}
		});

		// Focus input
		setTimeout(() => this.inputEl?.focus(), 50);
	}

	private async performSearch() {
		if (!this.inputEl || !this.resultsEl || !this.statusEl) return;

		const query = this.inputEl.value.trim();
		if (!query) {
			new Notice('Please enter a search query');
			return;
		}

		if (this.isSearching) {
			new Notice('Search already in progress');
			return;
		}

		// Check graph has data
		const stats = this.plugin.graphCache.getStats();
		if (stats.nodes === 0) {
			new Notice('No graph data. Analyze some notes first.');
			return;
		}

		this.isSearching = true;
		this.resultsEl.empty();
		this.statusEl.addClass('visible');
		this.statusEl.setText('Initializing...');

		try {
			const result = await executeSmartSearch(
				this.plugin,
				query,
				(status) => {
					if (this.statusEl) {
						this.statusEl.setText(status);
					}
				}
			);

			this.renderResults(result);
		} catch (e) {
			console.error('Smart search error:', e);
			new Notice(`Search failed: ${e instanceof Error ? e.message : 'Unknown error'}`);
			this.resultsEl.empty();
			this.resultsEl.createEl('p', {
				cls: 'smart-search-error',
				text: `Error: ${e instanceof Error ? e.message : 'Unknown error'}`,
			});
		} finally {
			this.isSearching = false;
			if (this.statusEl) {
				this.statusEl.removeClass('visible');
			}
		}
	}

	private renderResults(result: {
		answer: string;
		relevantNodes: Array<{ name: string; entityType: string; relevance: string }>;
		sourceNotes: Array<{ path: string; title: string; relevance: string }>;
	}) {
		if (!this.resultsEl) return;
		this.resultsEl.empty();

		// Answer section
		const answerSection = this.resultsEl.createDiv({ cls: 'smart-search-answer-section' });
		answerSection.createEl('h3', { text: 'Answer', cls: 'smart-search-section-title' });
		const answerEl = answerSection.createDiv({ cls: 'smart-search-answer' });
		answerEl.setText(result.answer);

		// Relevant nodes section
		if (result.relevantNodes.length > 0) {
			const nodesSection = this.resultsEl.createDiv({ cls: 'smart-search-nodes-section' });
			nodesSection.createEl('h3', { text: 'Relevant entities', cls: 'smart-search-section-title' });

			const nodesList = nodesSection.createEl('ul', { cls: 'smart-search-nodes-list' });
			for (const node of result.relevantNodes) {
				const item = nodesList.createEl('li', { cls: 'smart-search-node-item' });

				// Left side: badge + clickable name
				const nameContainer = item.createDiv({ cls: 'smart-search-node-name-container' });
				const badge = nameContainer.createEl('span', { cls: 'smart-search-label-badge', text: node.entityType });
				badge.style.backgroundColor = getEntityTypeColor(node.entityType);
				const nameLink = nameContainer.createEl('a', { cls: 'smart-search-node-link', text: node.name });
				nameLink.setAttribute('href', '#');
				nameLink.addEventListener('click', (e) => {
					e.preventDefault();
					// Open basic search modal with this node name
					this.close();
					// Use Obsidian command to open search with pre-filled query
					this.plugin.openSearchWithQuery(node.name);
				});

				// Right side: explanation (visually separated)
				if (node.relevance) {
					const relevanceEl = item.createEl('span', { cls: 'smart-search-node-relevance' });
					relevanceEl.createEl('span', { cls: 'smart-search-separator', text: '—' });
					relevanceEl.createEl('span', { text: node.relevance });
				}
			}
		}

		// Source notes section
		if (result.sourceNotes.length > 0) {
			const notesSection = this.resultsEl.createDiv({ cls: 'smart-search-notes-section' });
			notesSection.createEl('h3', { text: 'Source notes', cls: 'smart-search-section-title' });

			const notesList = notesSection.createEl('ul', { cls: 'smart-search-notes-list' });
			for (const note of result.sourceNotes) {
				const item = notesList.createEl('li', { cls: 'smart-search-note-item' });

				// Left side: clickable note link
				const link = item.createEl('a', { cls: 'smart-search-note-link', text: note.title });
				link.setAttribute('href', '#');
				link.addEventListener('click', (e) => {
					e.preventDefault();
					void this.app.workspace.openLinkText(note.path, '', false);
					this.close();
				});

				// Right side: explanation (visually separated)
				if (note.relevance) {
					const relevanceEl = item.createEl('span', { cls: 'smart-search-note-relevance' });
					relevanceEl.createEl('span', { cls: 'smart-search-separator', text: '—' });
					relevanceEl.createEl('span', { text: note.relevance });
				}
			}
		}

		// Empty state
		if (result.relevantNodes.length === 0 && result.sourceNotes.length === 0 && !result.answer) {
			this.resultsEl.createEl('p', {
				cls: 'smart-search-empty',
				text: 'No results found. Try a different query.',
			});
		}
	}

	/**
	 * Get the current model name based on provider.
	 */
	private getCurrentModelName(): string {
		const { apiProvider, claudeModel, openaiModel, geminiModel, ollamaModel } = this.plugin.settings;
		const modelMap: Record<string, string> = {
			claude: claudeModel,
			openai: openaiModel,
			gemini: geminiModel,
			ollama: ollamaModel,
		};
		return modelMap[apiProvider] || 'unknown';
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
