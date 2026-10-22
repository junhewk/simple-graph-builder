import { Setting, setIcon } from 'obsidian';
import type { Settings } from '../types';
import {
	DISPLAY_RANGES,
	GraphDisplaySettings,
	NumericDisplayKey,
	colorToHex,
} from '../graph/display';

/** What the panel lists about the graph currently on screen. */
export interface GraphLegend {
	types: { type: string; count: number; color: string; builtInColor: string }[];
	clusters: { index: number; name: string; size: number; color: string }[];
	/** Colour edges get when the user hasn't picked one. */
	themeEdgeColor: string;
}

export interface GraphControlsCallbacks {
	/** `display` was changed in place; restyle or re-lay out as the key needs. */
	onDisplayChange(key: keyof GraphDisplaySettings): void;
	/** A filter that changes which nodes exist (notes, minimum connections). */
	onFilterChange(): void;
	onClusterSelect(index: number): void;
	onRelayout(): void;
	onReset(): void;
}

type SectionKey = 'filters' | 'clusters' | 'nodes' | 'edges' | 'forces';

/**
 * Floating panel over the graph for adjusting what is drawn and how it is
 * laid out, in the spirit of Obsidian's own graph controls. Every change
 * applies live, so the user can see what a force or a filter does to the
 * picture instead of accepting the first layout they are handed.
 */
export class GraphControlsPanel {
	readonly el: HTMLElement;
	private legend: GraphLegend = { types: [], clusters: [], themeEdgeColor: '#64748b' };
	/** Which sections are expanded; survives the re-render on every legend update. */
	private readonly open = new Set<SectionKey>(['nodes']);

	constructor(
		parent: HTMLElement,
		private readonly settings: Settings,
		private display: GraphDisplaySettings,
		private readonly callbacks: GraphControlsCallbacks,
	) {
		this.el = parent.createDiv({ cls: 'sgb-graph-panel sgb-graph-controls' });
		this.el.hide();
		this.render();
	}

	isOpen(): boolean {
		return this.el.isShown();
	}

	toggle(force?: boolean): void {
		const show = force ?? !this.isOpen();
		if (show) this.el.show();
		else this.el.hide();
	}

	setDisplay(display: GraphDisplaySettings): void {
		this.display = display;
		this.render();
	}

	setLegend(legend: GraphLegend): void {
		this.legend = legend;
		this.render();
	}

	private render(): void {
		this.el.empty();
		const header = this.el.createDiv({ cls: 'sgb-graph-panel-header' });
		header.createSpan({ text: 'Graph display', cls: 'sgb-graph-panel-title' });
		const close = header.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.toggle(false));

		const body = this.el.createDiv({ cls: 'sgb-graph-panel-body' });
		this.renderFilters(this.section(body, 'filters', 'Filters'));
		this.renderClusters(this.section(body, 'clusters', 'Clusters'));
		this.renderNodes(this.section(body, 'nodes', 'Nodes'));
		this.renderEdges(this.section(body, 'edges', 'Edges'));
		this.renderForces(this.section(body, 'forces', 'Forces'));

		new Setting(body)
			.addButton(button => button
				.setButtonText('Restore defaults')
				.onClick(() => this.callbacks.onReset()));
	}

	private section(parent: HTMLElement, key: SectionKey, title: string): HTMLElement {
		const details = parent.createEl('details', { cls: 'sgb-graph-panel-section' });
		details.open = this.open.has(key);
		details.createEl('summary', { text: title });
		details.addEventListener('toggle', () => {
			if (details.open) this.open.add(key);
			else this.open.delete(key);
		});
		return details.createDiv({ cls: 'sgb-graph-panel-section-body' });
	}

	private renderFilters(el: HTMLElement): void {
		new Setting(el)
			.setName('Show notes')
			.addToggle(toggle => toggle
				.setValue(this.settings.graphShowNotes)
				.onChange(value => {
					this.settings.graphShowNotes = value;
					this.callbacks.onFilterChange();
				}));

		new Setting(el)
			.setName('Minimum connections')
			.addSlider(slider => slider
				.setLimits(0, 10, 1)
				.setValue(this.settings.graphMinDegree)
				.onChange(value => {
					this.settings.graphMinDegree = value;
					this.callbacks.onFilterChange();
				}));

		if (this.legend.types.length === 0) return;
		el.createDiv({ cls: 'sgb-graph-panel-subheading', text: 'Types' });
		const hidden = new Set(this.display.hiddenTypes);
		for (const { type, count, color, builtInColor } of this.legend.types) {
			const row = new Setting(el)
				.setName(type)
				.setDesc(`${count.toLocaleString()} shown`)
				.addColorPicker(picker => picker
					.setValue(colorToHex(color))
					.onChange(value => {
						this.display.typeColors[type] = value;
						this.callbacks.onDisplayChange('typeColors');
					}))
				.addToggle(toggle => toggle
					.setTooltip('Show this type')
					.setValue(!hidden.has(type))
					.onChange(value => {
						const next = new Set(this.display.hiddenTypes);
						if (value) next.delete(type);
						else next.add(type);
						this.display.hiddenTypes = [...next];
						this.callbacks.onDisplayChange('hiddenTypes');
					}));
			if (this.display.typeColors[type] && colorToHex(builtInColor) !== this.display.typeColors[type]) {
				row.addExtraButton(button => button
					.setIcon('rotate-ccw')
					.setTooltip('Default color')
					.onClick(() => {
						delete this.display.typeColors[type];
						this.callbacks.onDisplayChange('typeColors');
						this.render();
					}));
			}
			row.settingEl.addClass('sgb-graph-panel-type-row');
		}
	}

	private renderClusters(el: HTMLElement): void {
		new Setting(el)
			.setName('Color by cluster')
			.setDesc('Groups of densely connected nodes, found from the graph itself.')
			.addToggle(toggle => toggle
				.setValue(this.display.colorBy === 'cluster')
				.onChange(value => {
					this.display.colorBy = value ? 'cluster' : 'type';
					this.callbacks.onDisplayChange('colorBy');
				}));
		this.slider(el, 'clusterResolution', 'Cluster size', 'Higher finds more, smaller clusters.');
		this.slider(el, 'clusterPull', 'Cluster pull', 'Gather each cluster together in the layout.');

		if (this.legend.clusters.length === 0) {
			el.createDiv({ cls: 'sgb-graph-panel-empty', text: 'No clusters of three or more nodes.' });
			return;
		}
		const list = el.createDiv({ cls: 'sgb-graph-cluster-list' });
		for (const cluster of this.legend.clusters) {
			const row = list.createDiv({ cls: 'sgb-graph-cluster-row', attr: { 'aria-label': 'Highlight this cluster' } });
			const swatch = row.createSpan({ cls: 'sgb-graph-swatch' });
			swatch.setCssProps({ '--sgb-swatch-color': cluster.color });
			row.createSpan({ text: cluster.name, cls: 'sgb-graph-cluster-name' });
			row.createSpan({ text: String(cluster.size), cls: 'sgb-graph-count' });
			row.addEventListener('click', () => this.callbacks.onClusterSelect(cluster.index));
		}
	}

	private renderNodes(el: HTMLElement): void {
		this.slider(el, 'nodeSize', 'Size', '', true);
		this.slider(el, 'nodeOpacity', 'Opacity', '', true);
		this.slider(el, 'labelSize', 'Label size', '', true);
	}

	private renderEdges(el: HTMLElement): void {
		this.slider(el, 'edgeWidth', 'Thickness', '', true);
		this.slider(el, 'edgeOpacity', 'Opacity', 'Relative to each edge\'s connectivity.', true);

		const color = new Setting(el)
			.setName('Color')
			.addColorPicker(picker => picker
				.setValue(this.display.edgeColor || colorToHex(this.legend.themeEdgeColor))
				.onChange(value => {
					this.display.edgeColor = value;
					this.callbacks.onDisplayChange('edgeColor');
				}));
		if (this.display.edgeColor) {
			color.addExtraButton(button => button
				.setIcon('rotate-ccw')
				.setTooltip('Follow the theme')
				.onClick(() => {
					this.display.edgeColor = '';
					this.callbacks.onDisplayChange('edgeColor');
					this.render();
				}));
		}

		new Setting(el)
			.setName('Relationship labels')
			.setDesc('Write each relationship along its edge when zoomed in.')
			.addToggle(toggle => toggle
				.setValue(this.display.edgeLabels)
				.onChange(value => {
					this.display.edgeLabels = value;
					this.callbacks.onDisplayChange('edgeLabels');
				}));
	}

	private renderForces(el: HTMLElement): void {
		this.slider(el, 'repulsion', 'Repulsion', 'How hard nodes push each other apart.');
		this.slider(el, 'linkLength', 'Link length', 'How far apart connected nodes settle.');
		this.slider(el, 'gravity', 'Center pull', 'Keeps loose branches from drifting off.');
		this.slider(el, 'spacing', 'Spacing', 'Room kept clear around each node.');
	}

	/**
	 * A slider bound to one numeric display key; Obsidian prints its value
	 * beside it. `instant` sliders report every step of a drag, which suits a
	 * restyle; layout sliders report on release, since each report starts a
	 * new layout.
	 */
	private slider(el: HTMLElement, key: NumericDisplayKey, name: string, desc: string, instant = false): void {
		const { min, max, step } = DISPLAY_RANGES[key];
		const setting = new Setting(el).setName(name);
		if (desc) setting.setDesc(desc);
		setting.addSlider(slider => slider
			.setLimits(min, max, step)
			.setValue(this.display[key])
			.setInstant(instant)
			.onChange(value => {
				this.display[key] = value;
				this.callbacks.onDisplayChange(key);
			}));
	}
}
