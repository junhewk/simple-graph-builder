import { App, Modal, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { searchGraphCache, SearchResult } from '../graph/search';

/**
 * Open search modal, optionally with an initial query.
 */
export async function openSearchModal(plugin: SimpleGraphBuilderPlugin, initialQuery?: string): Promise<void> {
	new SearchModal(plugin.app, plugin, initialQuery).open();
}

class SearchModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private resultsContainer: HTMLElement;
	private initialQuery: string | undefined;
	private currentQuery = '';
	private exactMatch = false; // Default to fuzzy match for better discovery
	private labelFilter = ''; // Optional label filter

	constructor(app: App, plugin: SimpleGraphBuilderPlugin, initialQuery?: string) {
		super(app);
		this.plugin = plugin;
		this.initialQuery = initialQuery;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('simple-graph-search-modal');

		contentEl.createEl('h2', { text: 'Search Related Notes' });

		// Search input
		new Setting(contentEl)
			.setName('Search query')
			.setDesc('Enter a concept, entity name, or topic')
			.addText(text => {
				text.setPlaceholder('e.g., Machine Learning, Alice, Project Alpha')
					.onChange(async (value) => {
						this.currentQuery = value;
						this.performSearch();
					});

				// Set initial query if provided
				if (this.initialQuery) {
					text.setValue(this.initialQuery);
					this.currentQuery = this.initialQuery;
				}

				text.inputEl.focus();
			});

		// Label filter dropdown
		const labels = this.plugin.graphCache.getAllLabels();
		if (labels.length > 0) {
			new Setting(contentEl)
				.setName('Filter by label')
				.setDesc('Only show nodes with this label')
				.addDropdown(dropdown => {
					dropdown.addOption('', 'All labels');
					for (const label of labels.sort()) {
						dropdown.addOption(label, label);
					}
					dropdown.onChange(value => {
						this.labelFilter = value;
						this.performSearch();
					});
				});
		}

		// Exact match toggle
		new Setting(contentEl)
			.setName('Exact match')
			.setDesc('Only match nodes with exact name (case-insensitive)')
			.addToggle(toggle => {
				toggle
					.setValue(this.exactMatch)
					.onChange(value => {
						this.exactMatch = value;
						this.performSearch();
					});
			});

		this.resultsContainer = contentEl.createDiv({ cls: 'search-results' });

		// If initial query provided, perform search immediately
		if (this.initialQuery) {
			this.performSearch();
		} else {
			this.showHint();
		}
	}

	private showHint() {
		this.resultsContainer.empty();
		const stats = this.plugin.graphCache.getStats();
		const hint = this.resultsContainer.createEl('p', { cls: 'search-hint' });
		hint.textContent = `Enter a search term to find nodes. Graph has ${stats.nodes} nodes across ${Object.keys(stats.labels).length} labels.`;
	}

	private performSearch() {
		this.resultsContainer.empty();

		if (!this.currentQuery.trim()) {
			this.showHint();
			return;
		}

		const results = searchGraphCache(this.plugin.graphCache, this.currentQuery, {
			exactMatch: this.exactMatch,
			labelFilter: this.labelFilter || undefined,
		});

		if (results.length === 0) {
			this.resultsContainer.createEl('p', {
				text: 'No matching nodes found',
				cls: 'search-no-results'
			});
			return;
		}

		// Group results by label for better organization
		const resultsByLabel = new Map<string, SearchResult[]>();
		for (const result of results) {
			if (!resultsByLabel.has(result.nodeLabel)) {
				resultsByLabel.set(result.nodeLabel, []);
			}
			resultsByLabel.get(result.nodeLabel)!.push(result);
		}

		// Display results grouped by label
		for (const [label, labelResults] of resultsByLabel) {
			const section = this.resultsContainer.createDiv({ cls: 'search-label-section' });
			section.createEl('h4', { text: label, cls: 'search-label-header' });

			const list = section.createEl('ul', { cls: 'search-results-list' });
			for (const result of labelResults) {
				const item = list.createEl('li', { cls: 'search-result-item' });

				// Header row: name + score
				const headerRow = item.createDiv({ cls: 'search-result-header' });

				// Node name
				headerRow.createEl('span', {
					text: result.nodeName,
					cls: 'search-result-name',
				});

				// Score badge
				headerRow.createEl('span', {
					text: `${Math.round(result.score * 100)}%`,
					cls: 'search-result-score',
				});

				// Source notes
				if (result.sourceNotes.length > 0) {
					const notesEl = item.createEl('div', { cls: 'search-result-notes' });
					notesEl.createEl('span', { text: 'Found in: ', cls: 'search-result-notes-label' });

					for (let i = 0; i < Math.min(result.sourceNotes.length, 3); i++) {
						const notePath = result.sourceNotes[i];
						const noteLink = notesEl.createEl('a', {
							text: this.getNoteName(notePath),
							cls: 'search-result-note-link',
						});
						noteLink.addEventListener('click', (e) => {
							e.preventDefault();
							this.openNote(notePath);
						});

						if (i < Math.min(result.sourceNotes.length, 3) - 1) {
							notesEl.createEl('span', { text: ', ' });
						}
					}

					if (result.sourceNotes.length > 3) {
						notesEl.createEl('span', {
							text: ` +${result.sourceNotes.length - 3} more`,
							cls: 'search-result-more',
						});
					}
				}
			}
		}

		// Summary
		const summary = this.resultsContainer.createEl('p', { cls: 'search-summary' });
		summary.textContent = `Found ${results.length} nodes across ${resultsByLabel.size} labels`;
	}

	private getNoteName(path: string): string {
		return path.replace(/\.md$/, '').split('/').pop() || path;
	}

	private async openNote(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file) {
			await this.app.workspace.openLinkText(path, '', false);
			this.close();
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
