import { App, Modal, Setting, debounce } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import type { Connection, EntityHit, NoteHit, SearchResponse } from '../query/types';

export interface SearchModalOptions {
	/** Start the graph walk from this node: an entity id or a note path. */
	seed?: string;
	seedLabel?: string;
}

/**
 * Open the search modal, optionally with an initial query or a starting node.
 */
export function openSearchModal(plugin: SimpleGraphBuilderPlugin, initialQuery?: string, options: SearchModalOptions = {}): void {
	new SearchModal(plugin.app, plugin, initialQuery, options).open();
}

/**
 * Advanced search: notes and entities ranked by text match plus graph
 * proximity (see src/query/engine.ts). No API calls; results explain
 * themselves -- which words matched, and which entities connect a note to the
 * query.
 */
class SearchModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private resultsContainer: HTMLElement;
	private statusEl: HTMLElement;
	private query: string;
	private readonly options: SearchModalOptions;
	private typeFilter = '';
	/** Bumped per search, so a slow result never overwrites a newer one. */
	private generation = 0;
	private readonly debouncedSearch = debounce(() => void this.performSearch(), 200, true);

	constructor(app: App, plugin: SimpleGraphBuilderPlugin, initialQuery = '', options: SearchModalOptions = {}) {
		super(app);
		this.plugin = plugin;
		this.query = initialQuery;
		this.options = options;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('simple-graph-search-modal');
		this.modalEl.addClass('sgb-search-modal');

		contentEl.createEl('h2', { text: 'Search graph and notes' });

		new Setting(contentEl)
			.setName('Search query')
			.setDesc('Words, a concept, or an entity name. Related notes rank too, even without the words.')
			.addText(text => {
				text.setPlaceholder('Search notes, concepts, projects, or topics')
					.setValue(this.query)
					.onChange(value => {
						this.query = value;
						this.debouncedSearch();
					});
				text.inputEl.focus();
			});

		const types = this.plugin.queryEngine.entityTypes();
		if (types.length > 0) {
			new Setting(contentEl)
				.setName('Filter entities by type')
				.addDropdown(dropdown => {
					dropdown.addOption('', 'All entity types');
					for (const type of types) dropdown.addOption(type, type);
					dropdown.onChange(value => {
						this.typeFilter = value;
						void this.performSearch();
					});
				});
		}

		this.statusEl = contentEl.createDiv({ cls: 'search-status' });
		this.resultsContainer = contentEl.createDiv({ cls: 'search-results' });

		void this.plugin.queryEngine.ensureIndexed((indexed, total) => {
			this.statusEl.setText(indexed < total ? `Indexing notes… ${indexed}/${total}` : '');
		}).then(() => {
			this.statusEl.setText('');
			if (this.query.trim() || this.options.seed) void this.performSearch();
		});

		if (this.query.trim() || this.options.seed) {
			void this.performSearch();
		} else {
			this.showHint();
		}
	}

	private showHint() {
		this.resultsContainer.empty();
		const overview = this.plugin.queryEngine.overview();
		this.resultsContainer.createEl('p', {
			cls: 'search-hint',
			text: `Search ${overview.notes.total.toLocaleString()} notes and ${overview.entities.toLocaleString()} entities.`,
		});
	}

	private async performSearch() {
		const generation = ++this.generation;
		if (!this.query.trim() && !this.options.seed) {
			this.showHint();
			return;
		}

		const response = await this.plugin.queryEngine.search(this.query, {
			limit: 20,
			types: this.typeFilter ? [this.typeFilter] : undefined,
			seed: this.options.seed,
		});
		if (generation !== this.generation) return;
		this.render(response);
	}

	private render(response: SearchResponse) {
		this.resultsContainer.empty();

		if (this.options.seed && this.options.seedLabel) {
			this.resultsContainer.createEl('p', {
				cls: 'search-seed',
				text: `Around: ${this.options.seedLabel}`,
			});
		}

		if (response.notes.length === 0 && response.entities.length === 0) {
			this.resultsContainer.createEl('p', {
				text: response.indexing ? 'No matches yet. Still indexing notes…' : 'No matches found',
				cls: 'search-no-results',
			});
			return;
		}

		if (response.notes.length > 0) {
			const section = this.resultsContainer.createDiv({ cls: 'search-label-section' });
			section.createEl('h4', { text: 'Notes', cls: 'search-label-header' });
			const list = section.createEl('ul', { cls: 'search-results-list' });
			for (const hit of response.notes) this.renderNote(list, hit);
		}

		if (response.entities.length > 0) {
			const byType = new Map<string, EntityHit[]>();
			for (const hit of response.entities) {
				const list = byType.get(hit.type) ?? [];
				list.push(hit);
				byType.set(hit.type, list);
			}
			for (const [type, hits] of byType) {
				const section = this.resultsContainer.createDiv({ cls: 'search-label-section' });
				section.createEl('h4', { text: type, cls: 'search-label-header' });
				const list = section.createEl('ul', { cls: 'search-results-list' });
				for (const hit of hits) this.renderEntity(list, hit);
			}
		}

		const summary = this.resultsContainer.createEl('p', { cls: 'search-summary' });
		summary.setText(`${response.notes.length} notes, ${response.entities.length} entities`);
	}

	private renderNote(list: HTMLElement, hit: NoteHit) {
		const item = list.createEl('li', { cls: 'search-result-item' });
		const header = item.createDiv({ cls: 'search-result-header' });
		const link = header.createEl('a', { text: hit.title, cls: 'search-result-name search-result-note-link' });
		link.addEventListener('click', (e) => {
			e.preventDefault();
			void this.openNote(hit.path);
		});
		const folder = hit.path.includes('/') ? hit.path.slice(0, hit.path.lastIndexOf('/')) : '';
		if (folder) header.createSpan({ text: folder, cls: 'search-result-folder' });
		header.createSpan({ text: `${Math.round(hit.score * 100)}%`, cls: 'search-result-score' });

		if (hit.snippet) item.createDiv({ text: hit.snippet, cls: 'search-result-snippet' });

		const why = describeWhy(hit);
		if (why) item.createDiv({ text: why, cls: 'search-result-notes' });
	}

	private renderEntity(list: HTMLElement, hit: EntityHit) {
		const item = list.createEl('li', { cls: 'search-result-item' });
		const header = item.createDiv({ cls: 'search-result-header' });
		header.createSpan({ text: hit.name, cls: 'search-result-name' });
		header.createSpan({ text: `${Math.round(hit.score * 100)}%`, cls: 'search-result-score' });
		if (hit.description) item.createDiv({ text: hit.description, cls: 'search-result-snippet' });

		const details = this.plugin.queryEngine.getEntity(hit.id);
		const notes = 'sourceNotes' in details ? details.sourceNotes : [];
		if (notes.length > 0) {
			const notesEl = item.createDiv({ cls: 'search-result-notes' });
			notesEl.createSpan({ text: 'Found in: ', cls: 'search-result-notes-label' });
			const shown = notes.slice(0, 3);
			shown.forEach((path, i) => {
				const link = notesEl.createEl('a', { text: noteName(path), cls: 'search-result-note-link' });
				link.addEventListener('click', (e) => {
					e.preventDefault();
					void this.openNote(path);
				});
				if (i < shown.length - 1) notesEl.createSpan({ text: ', ' });
			});
			if (hit.noteCount > shown.length) {
				notesEl.createSpan({ text: ` +${hit.noteCount - shown.length} more`, cls: 'search-result-more' });
			}
		}
	}

	private async openNote(path: string) {
		await this.app.workspace.openLinkText(path, '', false);
		this.close();
	}

	onClose() {
		this.generation++;
		this.contentEl.empty();
	}
}

function describeWhy(hit: NoteHit): string {
	const parts: string[] = [];
	if (hit.matchedWords.length) parts.push(`Matched: ${hit.matchedWords.join(', ')}`);
	if (hit.connections.length) parts.push(`Via: ${hit.connections.slice(0, 3).map(describeConnection).join('; ')}`);
	return parts.join(' · ');
}

function describeConnection(connection: Connection): string {
	if (!connection.via) return connection.entity.name;
	const arrow = connection.via.direction === 'out'
		? `${connection.entity.name} —${connection.via.verb}→ ${connection.via.matched.name}`
		: `${connection.via.matched.name} —${connection.via.verb}→ ${connection.entity.name}`;
	return arrow;
}

function noteName(path: string): string {
	return path.replace(/\.md$/, '').split('/').pop() || path;
}
