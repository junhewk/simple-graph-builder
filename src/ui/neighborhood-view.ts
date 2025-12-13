import { ItemView, WorkspaceLeaf, MarkdownView } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { OntologyNode, OntologyEdge } from '../types';

export const NEIGHBORHOOD_VIEW_TYPE = 'simple-graph-neighborhood';

/**
 * Connection info for display in neighborhood view.
 */
interface ConnectionInfo {
	node: OntologyNode;
	edges: OntologyEdge[];
}

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

		// Get all nodes that have this note as a source
		const nodesFromNote = this.plugin.graphCache.getNodesBySourceNote(file.path);

		if (nodesFromNote.length === 0) {
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

		// Render current note info
		const currentSection = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-section' });
		currentSection.createEl('div', { cls: 'neighborhood-section-title', text: 'Current Note' });
		currentSection.createEl('div', { cls: 'neighborhood-current-note', text: file.basename });

		// Get all connected nodes (from this note's nodes)
		const connectionMap = new Map<string, ConnectionInfo>();

		for (const node of nodesFromNote) {
			const edges = this.plugin.graphCache.getConnectedEdges(node.id);
			for (const edge of edges) {
				const connectedId = edge.source === node.id ? edge.target : edge.source;
				const connectedNode = this.plugin.graphCache.getNodeById(connectedId);

				if (connectedNode && !nodesFromNote.some(n => n.id === connectedId)) {
					if (!connectionMap.has(connectedId)) {
						connectionMap.set(connectedId, { node: connectedNode, edges: [] });
					}
					connectionMap.get(connectedId)!.edges.push(edge);
				}
			}
		}

		// Group connections by label
		const connectionsByLabel = new Map<string, ConnectionInfo[]>();
		for (const connection of connectionMap.values()) {
			const label = connection.node.label;
			if (!connectionsByLabel.has(label)) {
				connectionsByLabel.set(label, []);
			}
			connectionsByLabel.get(label)!.push(connection);
		}

		// Render nodes extracted from this note
		this.renderExtractedNodes(nodesFromNote);

		// Render connections by label (sorted by count)
		const sortedLabels = Array.from(connectionsByLabel.entries())
			.sort((a, b) => b[1].length - a[1].length);

		for (const [label, connections] of sortedLabels) {
			this.renderConnectionSection(label, connections);
		}

		// Show empty state if no connections
		if (connectionMap.size === 0 && nodesFromNote.length === 0) {
			this.neighborhoodContentEl.createEl('p', {
				cls: 'neighborhood-empty',
				text: 'No connections found for this note.',
			});
		}
	}

	/**
	 * Render nodes extracted from the current note.
	 */
	private renderExtractedNodes(nodes: OntologyNode[]): void {
		if (!this.neighborhoodContentEl || nodes.length === 0) return;

		const section = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-section' });
		section.createEl('div', {
			cls: 'neighborhood-section-title',
			text: `Extracted Nodes (${nodes.length})`,
		});

		const list = section.createEl('ul', { cls: 'neighborhood-list' });
		for (const node of nodes) {
			const item = list.createEl('li', { cls: 'neighborhood-item neighborhood-item-extracted' });
			const labelBadge = item.createEl('span', { cls: 'neighborhood-label-badge', text: node.label });
			labelBadge.style.backgroundColor = this.getLabelColor(node.label);
			item.createEl('span', { cls: 'neighborhood-link', text: node.properties.name });
		}
	}

	/**
	 * Render a section of connections grouped by label.
	 */
	private renderConnectionSection(label: string, connections: ConnectionInfo[]): void {
		if (!this.neighborhoodContentEl) return;

		const section = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-section' });
		section.createEl('div', {
			cls: 'neighborhood-section-title',
			text: `${label} (${connections.length})`,
		});

		const list = section.createEl('ul', { cls: 'neighborhood-list' });
		for (const connection of connections) {
			const item = list.createEl('li', { cls: 'neighborhood-item' });

			const link = item.createEl('span', {
				cls: 'neighborhood-link clickable',
				text: connection.node.properties.name,
			});

			// Show relationship info on hover
			const edgeInfo = connection.edges
				.map(e => `${e.type}: ${e.properties.detail}`)
				.slice(0, 3)
				.join('; ');
			link.setAttr('aria-label', edgeInfo || 'Connected');

			// Click to show connected notes
			link.addEventListener('click', () => {
				this.showNodeDetailsPopup(connection.node);
			});
		}
	}

	/**
	 * Show popup with node details and source notes.
	 */
	private showNodeDetailsPopup(node: OntologyNode): void {
		if (!this.neighborhoodContentEl) return;

		// Remove existing popup if any
		const existingPopup = this.neighborhoodContentEl.querySelector('.neighborhood-popup');
		if (existingPopup) {
			existingPopup.remove();
		}

		const popup = this.neighborhoodContentEl.createDiv({ cls: 'neighborhood-popup' });

		const header = popup.createDiv({ cls: 'neighborhood-popup-header' });
		const labelBadge = header.createEl('span', { cls: 'neighborhood-label-badge', text: node.label });
		labelBadge.style.backgroundColor = this.getLabelColor(node.label);
		header.createEl('span', { text: node.properties.name });
		const closeBtn = header.createEl('button', { cls: 'neighborhood-popup-close', text: '×' });
		closeBtn.addEventListener('click', () => popup.remove());

		// Show source notes
		if (node.sourceNotes.length > 0) {
			popup.createEl('div', { cls: 'neighborhood-popup-subtitle', text: 'Found in:' });
			const list = popup.createEl('ul', { cls: 'neighborhood-popup-list' });
			for (const notePath of node.sourceNotes) {
				const item = list.createEl('li');
				const title = notePath.replace(/\.md$/, '').split('/').pop() || notePath;
				const link = item.createEl('span', { cls: 'neighborhood-link clickable', text: title });
				link.addEventListener('click', () => {
					this.app.workspace.openLinkText(notePath, '', false);
					popup.remove();
				});
			}
		}

		// Show relationships
		const edges = this.plugin.graphCache.getConnectedEdges(node.id);
		if (edges.length > 0) {
			popup.createEl('div', { cls: 'neighborhood-popup-subtitle', text: 'Relationships:' });
			const relList = popup.createEl('ul', { cls: 'neighborhood-popup-list' });
			for (const edge of edges.slice(0, 10)) {
				const sourceNode = this.plugin.graphCache.getNodeById(edge.source);
				const targetNode = this.plugin.graphCache.getNodeById(edge.target);
				if (sourceNode && targetNode) {
					const relItem = relList.createEl('li', { cls: 'neighborhood-relationship' });
					relItem.innerHTML = `<span class="rel-from">${sourceNode.properties.name}</span>
						<span class="rel-type">${edge.type}</span>
						<span class="rel-to">${targetNode.properties.name}</span>
						<span class="rel-detail">${edge.properties.detail}</span>`;
				}
			}
		}
	}

	/**
	 * Get color for a label (consistent with graph-view).
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

	async onClose() {
		// Cleanup
	}
}
