import { Plugin, TFile, debounce, Menu, Notice, WorkspaceLeaf } from 'obsidian';
import { Settings, PluginData } from './types';
import { DEFAULT_SETTINGS } from './settings';
import { migrateSettings } from './settings-migration';
import { SettingsTab } from './ui/settings-tab';
import { GraphView, GRAPH_VIEW_TYPE } from './ui/graph-view';
import { NeighborhoodView, NEIGHBORHOOD_VIEW_TYPE } from './ui/neighborhood-view';
import { GraphCache } from './graph/cache';
import { rebuildNoteLayer } from './graph/merge';
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
			callback: () => void openSearchModal(this),
		});

		this.addCommand({
			id: 'open-graph-view',
			name: 'Open graph view',
			callback: () => void this.activateGraphView(),
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
			callback: () => void this.activateNeighborhoodView(),
		});

		this.addCommand({
			id: 'smart-search',
			name: 'Smart search (AI-powered)',
			callback: () => void openSmartSearch(this),
		});

		this.addCommand({
			id: 'rebuild-note-layer',
			name: 'Rebuild note layer',
			callback: () => this.repairNoteLayer(true),
		});

		// Add settings tab
		this.addSettingTab(new SettingsTab(this.app, this));

		// Add ribbon icon with menu
		this.addRibbonIcon('waypoints', 'Simple graph builder', (evt) => {
			const menu = new Menu();

			menu.addItem((item) =>
				item
					.setTitle('Analyze current note')
					.setIcon('sparkles')
					.onClick(() => void analyzeCurrentNote(this))
			);

			menu.addItem((item) =>
				item
					.setTitle('Open graph view')
					.setIcon('git-fork')
					.onClick(() => void this.activateGraphView())
			);

			menu.showAtMouseEvent(evt);
		});

		// Add status bar item
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		// The note layer needs metadataCache.resolvedLinks, which is not populated
		// at plugin load. Only runs when there is something to do.
		this.app.workspace.onLayoutReady(() => this.repairNoteLayer(false));
	}

	/**
	 * Build (or repair) the NOTE node layer from data already in the graph.
	 *
	 * Runs automatically once per load so that graphs damaged by the old
	 * entity-level wikilink pass recover without the user re-analyzing their
	 * vault: `ensureLoaded` strips the junk edges, and this puts the note-to-note
	 * links back using Obsidian's own link index. No LLM calls, no file reads.
	 *
	 * `verbose` distinguishes the manual command, which should always say what it
	 * did, from the automatic pass, which stays quiet unless it changed something.
	 */
	repairNoteLayer(verbose: boolean): void {
		const pruned = this.graphCache.getPrunedLegacyEdgeCount();
		const merged = this.graphCache.getMergedDuplicateCount();
		const { noteNodesAdded, edgesAdded } = rebuildNoteLayer(this.graphCache, this.app);

		if (pruned > 0 || merged > 0) {
			const parts: string[] = [];
			if (pruned > 0) parts.push(`removed ${pruned.toLocaleString()} redundant link edges`);
			if (merged > 0) parts.push(`merged ${merged.toLocaleString()} duplicate entities`);
			if (noteNodesAdded > 0) parts.push(`added ${noteNodesAdded} note nodes`);
			new Notice(`Graph repaired: ${parts.join(', ')}.`);
		} else if (verbose) {
			new Notice(
				noteNodesAdded || edgesAdded
					? `Note layer rebuilt: ${noteNodesAdded} note nodes, ${edgesAdded} edges added.`
					: 'Note layer is already up to date.'
			);
		}

		if (noteNodesAdded || edgesAdded || pruned || merged) {
			this.updateStatusBar();
			void this.graphCache.flush();
		}
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
				.sort((a, b) => b[1] - a[1])
				.map(([label, count]) => `  ${label}: ${count}`)
				.join('\n');

			this.statusBarItem.setAttr('aria-label',
				`Knowledge Graph\nNodes: ${stats.nodes}\nEdges: ${stats.edges}\n\nBy label:\n${labelDetails}`
			);
		}
	}

	async activateGraphView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = this.settings.openGraphInMain
				? workspace.getLeaf(true)
				: workspace.getRightLeaf(false);

			if (leaf) {
				await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
			const view = leaf.view;
			if (view instanceof GraphView) {
				await view.refresh();
			}
		}
	}

	async activateNeighborhoodView() {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(NEIGHBORHOOD_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({ type: NEIGHBORHOOD_VIEW_TYPE, active: true });
			}
		}

		if (leaf) {
			await workspace.revealLeaf(leaf);
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

	onunload(): void {
		// Flush any pending graph changes
		void this.graphCache.flush();
	}

	async loadSettings() {
		const data = (await this.loadData()) as PluginData | null;

		// Read the stored version before merging: Object.assign fills a missing
		// settingsVersion in from DEFAULT_SETTINGS, which would make an
		// un-migrated install look current.
		const storedVersion = (data?.settings as Partial<Settings> | undefined)?.settingsVersion ?? 0;

		this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);

		const { settings, changed, notes } = migrateSettings(this.settings, storedVersion);
		this.settings = settings;

		if (changed) {
			if (notes.length) {
				console.debug('[simple-graph-builder] Migrated settings:', notes.join('; '));
			}
			await this.saveSettings();
		}
	}

	async saveSettings() {
		const data = ((await this.loadData()) as PluginData | null) ?? {
			settings: DEFAULT_SETTINGS,
			graph: { nodes: [], edges: [], version: 1 },
			hashes: { hashes: [] },
		};
		data.settings = this.settings;
		await this.saveData(data);
	}
}
