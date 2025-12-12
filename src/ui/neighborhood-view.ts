import { ItemView, WorkspaceLeaf, MarkdownView } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { GraphNode } from '../types';

export const NEIGHBORHOOD_VIEW_TYPE = 'simple-graph-neighborhood';

export class NeighborhoodView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	private neighborhoodContentEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return NEIGHBORHOOD_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Note Neighborhood';
	}

	getIcon(): string {
		return 'network';
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('neighborhood-view-container');

		// Header
		container.createEl('div', { cls: 'neighborhood-header', text: 'Note Neighborhood' });

		// Content area
		this.neighborhoodContentEl = container.createDiv({ cls: 'neighborhood-content' });

		// Initial render
		this.refresh();

		// Listen for active leaf changes
		this.registerEvent(
			this.app.workspace.on('active-leaf-change', () => {
				this.refresh();
			})
		);
	}

	/**
	 * Refresh the neighborhood view for the current active note.
	 */
	refresh(): void {
		if (!this.neighborhoodContentEl) return;
		this.neighborhoodContentEl.empty();

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView?.file) {
			this.neighborhoodContentEl.createEl('p', {
				cls: 'neighborhood-empty',
				text: 'Open a note to see its neighborhood.',
			});
			return;
		}

		const file = activeView.file;
		const noteNode = this.plugin.graphCache.getNodeByNotePath(file.path);

		if (!noteNode) {
			this.neighborhoodContentEl.createEl('p', {
				cls: 'neighborhood-empty',
				text: 'This note has not been analyzed yet.',
			});
			const analyzeBtn = this.neighborhoodContentEl.createEl('button', {
				cls: 'neighborhood-analyze-btn',
				text: 'Analyze this note',
			});
			analyzeBtn.addEventListener('click', async () => {
				const { analyzeCurrentNote } = await import('../commands/analyze');
				await analyzeCurrentNote(this.plugin);
				this.refresh();
			});
			return;
		}

		// Get connected nodes
		const connectedNodes = this.plugin.graphCache.getConnectedNodes(noteNode.id);

		// Group by type
		const linkedNotes = connectedNodes.filter(n => n.type === 'note');
		const entities = connectedNodes.filter(n => n.type === 'entity');
		const keywords = connectedNodes.filter(n => n.type === 'keyword');

		// Render current note info
		const currentSection = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-section' });
		currentSection.createEl('div', { cls: 'neighborhood-section-title', text: 'Current Note' });
		currentSection.createEl('div', { cls: 'neighborhood-current-note', text: file.basename });

		// Render linked notes
		if (linkedNotes.length > 0) {
			this.renderSection('Linked Notes', linkedNotes, 'note');
		}

		// Render entities
		if (entities.length > 0) {
			this.renderSection('Entities', entities, 'entity');
		}

		// Render keywords
		if (keywords.length > 0) {
			this.renderSection('Keywords', keywords, 'keyword');
		}

		// Show empty state if no connections
		if (linkedNotes.length === 0 && entities.length === 0 && keywords.length === 0) {
			this.neighborhoodContentEl.createEl('p', {
				cls: 'neighborhood-empty',
				text: 'No connections found for this note.',
			});
		}
	}

	private renderSection(title: string, nodes: GraphNode[], type: 'note' | 'entity' | 'keyword'): void {
		if (!this.neighborhoodContentEl) return;

		const section = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-section' });
		section.createEl('div', {
			cls: 'neighborhood-section-title',
			text: `${title} (${nodes.length})`,
		});

		const list = section.createEl('ul', { cls: 'neighborhood-list' });
		for (const node of nodes) {
			const item = list.createEl('li', { cls: `neighborhood-item neighborhood-item-${type}` });
			const link = item.createEl('span', { cls: 'neighborhood-link', text: node.label });

			if (type === 'note' && node.notePath) {
				link.addClass('clickable');
				link.addEventListener('click', () => {
					if (node.notePath) {
						this.app.workspace.openLinkText(node.notePath, '', false);
					}
				});
			} else if (type === 'entity' || type === 'keyword') {
				// Show connected notes count on hover
				const connectedNotes = this.getConnectedNotes(node.id);
				if (connectedNotes.length > 0) {
					link.setAttr('aria-label', `Connected to ${connectedNotes.length} note(s)`);
					link.addClass('clickable');
					link.addEventListener('click', () => {
						this.showConnectedNotesPopup(node, connectedNotes);
					});
				}
			}
		}
	}

	private getConnectedNotes(nodeId: string): GraphNode[] {
		return this.plugin.graphCache.getConnectedNodes(nodeId).filter(n => n.type === 'note');
	}

	private showConnectedNotesPopup(node: GraphNode, connectedNotes: GraphNode[]): void {
		if (!this.neighborhoodContentEl) return;

		// Remove existing popup if any
		const existingPopup = this.neighborhoodContentEl.querySelector('.neighborhood-popup');
		if (existingPopup) {
			existingPopup.remove();
		}

		const popup = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-popup' });

		const header = popup.createDiv({ cls: 'neighborhood-popup-header' });
		header.createEl('span', { text: `Notes with "${node.label}"` });
		const closeBtn = header.createEl('button', { cls: 'neighborhood-popup-close', text: '×' });
		closeBtn.addEventListener('click', () => popup.remove());

		const list = popup.createEl('ul', { cls: 'neighborhood-popup-list' });
		for (const note of connectedNotes) {
			const item = list.createEl('li');
			const link = item.createEl('span', { cls: 'neighborhood-link clickable', text: note.label });
			link.addEventListener('click', () => {
				if (note.notePath) {
					this.app.workspace.openLinkText(note.notePath, '', false);
					popup.remove();
				}
			});
		}
	}

	async onClose() {
		// Cleanup
	}
}
