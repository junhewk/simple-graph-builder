import { App, Modal, Setting, Notice } from 'obsidian';
import { OntologyNode, normalizeKey } from '../types';
import { EntityResolver } from '../graph/resolver';
import { deleteEntityNote, upsertEntityNotes } from '../sync';
import type SimpleGraphBuilderPlugin from '../main';

/**
 * Modal for manually merging two entities.
 * The source entity's name becomes an alias of the target entity.
 */
export class EntityMergeModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private sourceNode: OntologyNode;
	private targetNode: OntologyNode | null = null;
	private searchQuery = '';
	private searchResults: OntologyNode[] = [];

	constructor(app: App, plugin: SimpleGraphBuilderPlugin, sourceNode: OntologyNode) {
		super(app);
		this.plugin = plugin;
		this.sourceNode = sourceNode;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('entity-merge-modal');

		contentEl.createEl('h2', { text: 'Merge entity' });

		// Source entity info
		const sourceSection = contentEl.createDiv({ cls: 'entity-merge-source' });
		sourceSection.createEl('h4', { text: 'Source entity (will be merged into target)' });

		const sourceInfo = sourceSection.createDiv({ cls: 'entity-info' });
		sourceInfo.createSpan({ text: this.sourceNode.properties.name, cls: 'entity-name' });
		sourceInfo.createSpan({ text: this.sourceNode.entityType || this.sourceNode.label || 'CONCEPT', cls: 'entity-label' });

		if (this.sourceNode.properties.aliases && this.sourceNode.properties.aliases.length > 0) {
			const aliasesEl = sourceSection.createDiv({ cls: 'entity-aliases' });
			aliasesEl.createSpan({ text: 'Aliases: ' });
			aliasesEl.createSpan({ text: this.sourceNode.properties.aliases.join(', '), cls: 'alias-list' });
		}

		const sourceNotesEl = sourceSection.createDiv({ cls: 'entity-sources' });
		sourceNotesEl.createSpan({ text: `Source notes: ${this.sourceNode.sourceNotes.length}` });

		// Target entity search
		const targetSection = contentEl.createDiv({ cls: 'entity-merge-target' });
		targetSection.createEl('h4', { text: 'Target entity (will receive the merge)' });

		new Setting(targetSection)
			.setName('Search for target entity')
			.addText(text => {
				text
					.setPlaceholder('Type to search...')
					.onChange(value => {
						this.searchQuery = value;
						this.updateSearchResults();
					});
				text.inputEl.focus();
			});

		// Search results container
		const resultsContainer = targetSection.createDiv({ cls: 'entity-search-results' });
		this.renderSearchResults(resultsContainer);

		// Selected target info
		const selectedContainer = targetSection.createDiv({ cls: 'entity-selected-target' });
		this.renderSelectedTarget(selectedContainer);

		// Merge button
		const buttonContainer = contentEl.createDiv({ cls: 'entity-merge-buttons' });
		new Setting(buttonContainer)
			.addButton(button => {
				button
					.setButtonText('Cancel')
					.onClick(() => this.close());
			})
			.addButton(button => {
				button
					.setButtonText('Merge')
					.setCta()
					.setDisabled(this.targetNode === null)
					.onClick(async () => {
						if (this.targetNode) {
							await this.performMerge();
						}
					});
			});
	}

	private updateSearchResults() {
		const resultsContainer = this.contentEl.querySelector('.entity-search-results');
		if (!resultsContainer) return;

		// Search for matching nodes
		if (this.searchQuery.length < 2) {
			this.searchResults = [];
		} else {
			const query = normalizeKey(this.searchQuery);
			this.searchResults = this.plugin.graphCache.getAllNodes()
				.filter(node => {
					// Don't include the source node
					if (node.id === this.sourceNode.id) return false;

					// Match name
					if (normalizeKey(node.properties.name).includes(query)) return true;

					// Match aliases
					const aliases = node.properties.aliases || [];
					if (aliases.some(a => normalizeKey(a).includes(query))) return true;

					return false;
				})
				.slice(0, 10); // Limit results
		}

		this.renderSearchResults(resultsContainer as HTMLElement);
	}

	private renderSearchResults(container: HTMLElement) {
		container.empty();

		if (this.searchQuery.length < 2) {
			container.createDiv({ text: 'Type at least 2 characters to search', cls: 'search-hint' });
			return;
		}

		if (this.searchResults.length === 0) {
			container.createDiv({ text: 'No matching entities found', cls: 'search-hint' });
			return;
		}

		for (const node of this.searchResults) {
			const resultEl = container.createDiv({ cls: 'entity-search-result' });
			resultEl.createSpan({ text: node.properties.name, cls: 'entity-name' });
			resultEl.createSpan({ text: node.entityType || node.label || 'CONCEPT', cls: 'entity-label' });

			const aliases = node.properties.aliases || [];
			if (aliases.length > 0) {
				resultEl.createSpan({ text: ` (${aliases.slice(0, 3).join(', ')}${aliases.length > 3 ? '...' : ''})`, cls: 'alias-preview' });
			}

			resultEl.onclick = () => {
				this.targetNode = node;
				this.renderSelectedTarget(this.contentEl.querySelector('.entity-selected-target') as HTMLElement);
				// Enable merge button
				const mergeButton = this.contentEl.querySelector('.mod-cta') as HTMLButtonElement;
				if (mergeButton) mergeButton.disabled = false;
			};

			// Highlight if selected
			if (this.targetNode && this.targetNode.id === node.id) {
				resultEl.addClass('selected');
			}
		}
	}

	private renderSelectedTarget(container: HTMLElement) {
		container.empty();

		if (!this.targetNode) {
			container.createDiv({ text: 'Select a target entity from the search results above', cls: 'select-hint' });
			return;
		}

		container.createEl('h5', { text: 'Selected target:' });

		const targetInfo = container.createDiv({ cls: 'entity-info selected' });
		targetInfo.createSpan({ text: this.targetNode.properties.name, cls: 'entity-name' });
		targetInfo.createSpan({ text: this.targetNode.entityType || this.targetNode.label || 'CONCEPT', cls: 'entity-label' });

		const aliases = this.targetNode.properties.aliases || [];
		if (aliases.length > 0) {
			const aliasesEl = container.createDiv({ cls: 'entity-aliases' });
			aliasesEl.createSpan({ text: 'Existing aliases: ' });
			aliasesEl.createSpan({ text: aliases.join(', '), cls: 'alias-list' });
		}

		// Preview what will happen
		const previewEl = container.createDiv({ cls: 'merge-preview' });
		previewEl.createEl('p', {
			text: `After merge: "${this.sourceNode.properties.name}" will become an alias of "${this.targetNode.properties.name}"`
		});
	}

	private async performMerge() {
		if (!this.targetNode) return;

		try {
			const resolver = new EntityResolver(this.plugin.graphCache, this.plugin.settings);
			const success = resolver.mergeEntities(this.sourceNode.id, this.targetNode.id);

			if (success) {
				// The merged-away entity's note goes to the trash, and the survivor
				// is rewritten with the aliases and relationships it inherited.
				if (this.plugin.settings.enableEntityNotes) {
					try {
						await deleteEntityNote(this.plugin, this.sourceNode);
						const merged = this.plugin.graphCache.getNodeById(this.targetNode.id);
						if (merged) await upsertEntityNotes(this.plugin, [merged]);
					} catch (error) {
						console.error('Simple Graph Builder: could not update entity notes after merge', error);
					}
				}

				await this.plugin.graphCache.flush();
				new Notice(`Merged "${this.sourceNode.properties.name}" into "${this.targetNode.properties.name}"`);
				this.plugin.updateStatusBar();
				this.close();
			} else {
				new Notice('Failed to merge entities');
			}
		} catch (error) {
			console.error('Merge failed:', error);
			new Notice(`Merge failed: ${(error as Error).message}`);
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Open the entity merge modal for a given node.
 */
export function openEntityMergeModal(plugin: SimpleGraphBuilderPlugin, sourceNode: OntologyNode): void {
	new EntityMergeModal(plugin.app, plugin, sourceNode).open();
}
