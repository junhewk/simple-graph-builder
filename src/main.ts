import { Plugin, TFile, debounce, Menu } from 'obsidian';
import { Settings, PluginData } from './types';
import { DEFAULT_SETTINGS } from './settings';
import { SettingsTab } from './ui/settings-tab';
import { GraphView, GRAPH_VIEW_TYPE } from './ui/graph-view';
import { NeighborhoodView, NEIGHBORHOOD_VIEW_TYPE } from './ui/neighborhood-view';
import { GraphCache } from './graph/cache';
import { analyzeCurrentNote, removeCurrentNoteFromGraph, clearAllGraphData, autoAnalyzeFile } from './commands/analyze';
import { openSearchModal } from './commands/search';
import { openSmartSearch } from './commands/smart-search';

export default class SimpleGraphBuilderPlugin extends Plugin {
	settings: Settings;
	graphCache: GraphCache;
	private statusBarItem: HTMLElement | null = null;

	// Debounced auto-analyze to avoid multiple calls on rapid saves
	private debouncedAutoAnalyze = debounce(
		(file: TFile) => autoAnalyzeFile(this, file),
		2000, // Wait 2 seconds after last save before analyzing
		true
	);

	async onload() {
		await this.loadSettings();
		this.graphCache = new GraphCache(this);
		await this.graphCache.ensureLoaded();

		// Register graph view
		this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));

		// Register neighborhood view
		this.registerView(NEIGHBORHOOD_VIEW_TYPE, (leaf) => new NeighborhoodView(leaf, this));

		// Register auto-analysis on file modify
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.extension === 'md') {
					this.debouncedAutoAnalyze(file);
				}
			})
		);

		// Add commands
		this.addCommand({
			id: 'analyze-current-note',
			name: 'Analyze current note',
			callback: () => analyzeCurrentNote(this),
		});

		this.addCommand({
			id: 'search-related-notes',
			name: 'Search related notes',
			callback: () => openSearchModal(this),
		});

		this.addCommand({
			id: 'open-graph-view',
			name: 'Open graph view',
			callback: () => this.activateGraphView(),
		});

		this.addCommand({
			id: 'remove-note-from-graph',
			name: 'Remove current note from graph',
			callback: () => removeCurrentNoteFromGraph(this),
		});

		this.addCommand({
			id: 'clear-graph',
			name: 'Clear all graph data',
			callback: () => clearAllGraphData(this),
		});

		this.addCommand({
			id: 'open-neighborhood-view',
			name: 'Open note neighborhood panel',
			callback: () => this.activateNeighborhoodView(),
		});

		this.addCommand({
			id: 'smart-search',
			name: 'Smart Search (AI-powered)',
			callback: () => openSmartSearch(this),
		});

		// Add settings tab
		this.addSettingTab(new SettingsTab(this.app, this));

		// Add ribbon icon with menu
		this.addRibbonIcon('waypoints', 'Simple Graph Builder', (evt) => {
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle('Analyze current note')
					.setIcon('sparkles')
					.onClick(() => analyzeCurrentNote(this))
			);

			menu.addItem((item) =>
				item
					.setTitle('Open graph view')
					.setIcon('git-fork')
					.onClick(() => this.activateGraphView())
			);

			menu.showAtMouseEvent(evt);
		});

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();
	}

	/**
	 * Update the status bar with current graph stats.
	 */
	updateStatusBar(): void {
		if (!this.statusBarItem) return;

		const stats = this.graphCache.getStats();
		if (stats.nodes === 0) {
			this.statusBarItem.setText('Graph: empty');
		} else {
			this.statusBarItem.setText(`Graph: ${stats.nodes} nodes, ${stats.edges} edges`);

			// Build detailed tooltip
			const labelDetails = Object.entries(stats.labels)
				.sort((a: [string, number], b: [string, number]) => b[1] - a[1])
				.map(([label, count]: [string, number]) => `  ${label}: ${count}`)
				.join('\n');

			this.statusBarItem.setAttr('aria-label',
				`Knowledge Graph\nNodes: ${stats.nodes}\nEdges: ${stats.edges}\n\nBy label:\n${labelDetails}`
			);
		}
	}

	async activateGraphView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0];
		if (!leaf) {
			if (this.settings.openGraphInMain) {
				leaf = workspace.getLeaf(true);
			} else {
				const rightLeaf = workspace.getRightLeaf(false);
				if (rightLeaf) {
					leaf = rightLeaf;
				}
			}

			if (leaf) {
				await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
			// Refresh the graph view with latest data
			const view = leaf.view;
			if (view instanceof GraphView) {
				await view.refresh();
			}
		}
	}

	async activateNeighborhoodView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(NEIGHBORHOOD_VIEW_TYPE)[0];
		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				leaf = rightLeaf;
				await leaf.setViewState({ type: NEIGHBORHOOD_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
			// Refresh the neighborhood view
			const view = leaf.view;
			if (view instanceof NeighborhoodView) {
				view.refresh();
			}
		}
	}

	/**
	 * Open the search modal with a pre-filled query.
	 */
	openSearchWithQuery(query: string): void {
		openSearchModal(this, query);
	}

	async onunload() {
		// Flush any pending graph changes
		await this.graphCache.flush();
	}

	async loadSettings() {
		const data: PluginData | null = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
	}

	async saveSettings() {
		const data: PluginData = (await this.loadData()) ?? {
			settings: DEFAULT_SETTINGS,
			graph: { nodes: [], edges: [], version: 1 },
			hashes: { hashes: [] },
		};
		data.settings = this.settings;
		await this.saveData(data);
	}
}
