import { App, Modal, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { searchGraphCache } from '../graph/search';

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
	private exactMatch = true; // Default to exact match

	constructor(app: App, plugin: SimpleGraphBuilderPlugin, initialQuery?: string) {
		super(app);
		this.plugin = plugin;
		this.initialQuery = initialQuery;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('simple-graph-search-modal');

		contentEl.createEl('h2', { text: 'Search related notes' });

		new Setting(contentEl)
			.setName('Search query')
			.setDesc('Enter a concept, keyword, or topic')
			.addText(text => {
				text.setPlaceholder('e.g., AI, regression, research')
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

		new Setting(contentEl)
			.setName('Exact match')
			.setDesc('Only match entities/keywords with exact name')
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
			this.resultsContainer.createEl('p', { text: 'Enter a search term to find related notes', cls: 'search-hint' });
		}
	}

	private performSearch() {
		this.resultsContainer.empty();

		if (!this.currentQuery.trim()) {
			this.resultsContainer.createEl('p', { text: 'Enter a search term to find related notes', cls: 'search-hint' });
			return;
		}

		const results = searchGraphCache(this.plugin.graphCache, this.currentQuery, { exactMatch: this.exactMatch });

		if (results.length === 0) {
			this.resultsContainer.createEl('p', { text: 'No related notes found', cls: 'search-no-results' });
			return;
		}

		const list = this.resultsContainer.createEl('ul', { cls: 'search-results-list' });
		for (const result of results) {
			const item = list.createEl('li', { cls: 'search-result-item' });

			const link = item.createEl('a', {
				text: result.noteLabel,
				cls: 'search-result-link',
			});
			link.addEventListener('click', (e) => {
				e.preventDefault();
				this.openNote(result.notePath);
			});

			const meta = item.createEl('div', { cls: 'search-result-meta' });
			meta.createEl('span', { text: `Score: ${result.score}` });
			if (result.matchedEntities.length > 0) {
				meta.createEl('span', { text: ` • Matched: ${result.matchedEntities.slice(0, 3).join(', ')}` });
			}
		}
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
