/**
 * Smart Search Modal - Natural language search UI with AI-generated answers.
 */

import { App, Modal, Notice } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { executeSmartSearch } from '../commands/smart-search';
import { supportsToolCalling } from '../settings';

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
		contentEl.addClass('smart-search-modal');
		contentEl.style.padding = '20px';

		// Title
		const titleEl = contentEl.createEl('h2', { text: 'Smart Search', cls: 'smart-search-title' });
		titleEl.style.margin = '0 0 8px 0';
		titleEl.style.fontSize = '1.5em';
		titleEl.style.fontWeight = '600';

		const descEl = contentEl.createEl('p', {
			cls: 'smart-search-description',
			text: 'Ask a question about your knowledge graph. The AI will explore connections and provide an answer with sources.',
		});
		descEl.style.margin = '0 0 16px 0';
		descEl.style.color = 'var(--text-muted)';
		descEl.style.fontSize = '0.9em';

		// Input area
		const inputContainer = contentEl.createDiv({ cls: 'smart-search-input-container' });
		inputContainer.style.width = '100%';
		inputContainer.style.marginBottom = '12px';

		this.inputEl = inputContainer.createEl('textarea', {
			cls: 'smart-search-input',
			attr: {
				placeholder: 'e.g., "What methods did we use for the recommendation project?" or "Who is connected to Alice?"',
				rows: '3',
			},
		});
		this.inputEl.style.width = '100%';
		this.inputEl.style.boxSizing = 'border-box';
		this.inputEl.style.padding = '10px';
		this.inputEl.style.resize = 'vertical';

		// Search button
		const buttonContainer = contentEl.createDiv({ cls: 'smart-search-buttons' });
		buttonContainer.style.marginBottom = '16px';

		const searchBtn = buttonContainer.createEl('button', {
			cls: 'smart-search-btn mod-cta',
			text: 'Search',
		});

		// Check if model supports tool calling
		const toolSupported = supportsToolCalling(this.plugin.settings);
		if (!toolSupported) {
			searchBtn.disabled = true;
			searchBtn.style.opacity = '0.5';
			searchBtn.style.cursor = 'not-allowed';

			const warningEl = contentEl.createDiv({ cls: 'smart-search-warning' });
			warningEl.style.padding = '10px';
			warningEl.style.marginBottom = '12px';
			warningEl.style.backgroundColor = 'var(--background-modifier-error)';
			warningEl.style.borderRadius = '4px';
			warningEl.style.color = 'var(--text-error)';
			warningEl.innerHTML = `
				<strong>Model not supported:</strong> The current model (<code>${this.getCurrentModelName()}</code>) has limited tool calling support.
				<br>Smart Search requires tool calling. Please switch to a compatible model in settings.
			`;
		}

		// Status indicator
		this.statusEl = contentEl.createDiv({ cls: 'smart-search-status' });
		this.statusEl.style.display = 'none';
		this.statusEl.style.padding = '10px';
		this.statusEl.style.color = 'var(--text-muted)';
		this.statusEl.style.fontStyle = 'italic';

		// Results area
		this.resultsEl = contentEl.createDiv({ cls: 'smart-search-results' });

		// Event handlers
		searchBtn.addEventListener('click', () => this.performSearch());
		this.inputEl.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.performSearch();
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
		this.statusEl.style.display = 'block';
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
				this.statusEl.style.display = 'none';
			}
		}
	}

	private renderResults(result: {
		answer: string;
		relevantNodes: Array<{ name: string; label: string; relevance: string }>;
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
			nodesSection.createEl('h3', { text: 'Relevant Entities', cls: 'smart-search-section-title' });

			const nodesList = nodesSection.createEl('ul', { cls: 'smart-search-nodes-list' });
			for (const node of result.relevantNodes) {
				const item = nodesList.createEl('li', { cls: 'smart-search-node-item' });

				// Left side: badge + clickable name
				const nameContainer = item.createDiv({ cls: 'smart-search-node-name-container' });
				const badge = nameContainer.createEl('span', { cls: 'smart-search-label-badge', text: node.label });
				badge.style.backgroundColor = this.getLabelColor(node.label);
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
			notesSection.createEl('h3', { text: 'Source Notes', cls: 'smart-search-section-title' });

			const notesList = notesSection.createEl('ul', { cls: 'smart-search-notes-list' });
			for (const note of result.sourceNotes) {
				const item = notesList.createEl('li', { cls: 'smart-search-note-item' });

				// Left side: clickable note link
				const link = item.createEl('a', { cls: 'smart-search-note-link', text: note.title });
				link.setAttribute('href', '#');
				link.addEventListener('click', (e) => {
					e.preventDefault();
					this.app.workspace.openLinkText(note.path, '', false);
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
	 * Get color for a label (consistent with graph-view and neighborhood-view).
	 */
	private getLabelColor(label: string): string {
		const LABEL_COLORS: Record<string, string> = {
			Person: '#6366f1',
			Organization: '#8b5cf6',
			Team: '#a78bfa',
			Concept: '#14b8a6',
			Theory: '#2dd4bf',
			Method: '#5eead4',
			Technique: '#67e8f9',
			Project: '#a855f7',
			Product: '#c084fc',
			System: '#d8b4fe',
			Tool: '#f59e0b',
			Library: '#fbbf24',
			Framework: '#fcd34d',
			Software: '#fde68a',
			Event: '#f472b6',
			Meeting: '#f9a8d4',
			Conference: '#fbcfe8',
			Document: '#60a5fa',
			Paper: '#93c5fd',
			Book: '#bfdbfe',
			Place: '#4ade80',
			Location: '#86efac',
		};

		if (LABEL_COLORS[label]) return LABEL_COLORS[label];

		// Hash-based color generation for unknown labels
		let hash = 0;
		for (let i = 0; i < label.length; i++) {
			hash = label.charCodeAt(i) + ((hash << 5) - hash);
		}
		const hue = Math.abs(hash) % 360;
		return `hsl(${hue}, 70%, 60%)`;
	}

	/**
	 * Get the current model name based on provider.
	 */
	private getCurrentModelName(): string {
		const { apiProvider } = this.plugin.settings;
		switch (apiProvider) {
			case 'claude':
				return this.plugin.settings.claudeModel;
			case 'openai':
				return this.plugin.settings.openaiModel;
			case 'gemini':
				return this.plugin.settings.geminiModel;
			case 'ollama':
				return this.plugin.settings.ollamaModel;
			default:
				return 'unknown';
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
