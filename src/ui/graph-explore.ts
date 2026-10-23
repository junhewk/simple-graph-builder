import { setIcon } from 'obsidian';

/** One node in a list the user can jump to. */
export interface NodeRow {
	/** Rendered node id, or null when filters keep the node out of the view. */
	id: string | null;
	name: string;
	type: string;
	color: string;
	/** Why it is in the list: which words matched, what connects it. */
	reason?: string;
	/** Vault path, for a note that can be opened even when it isn't drawn. */
	notePath?: string;
}

export interface SearchResults {
	/** What the list is about when it isn't the typed query ("Around X", a cluster). */
	heading?: string;
	matches: NodeRow[];
	related: NodeRow[];
	status?: string;
}

export interface SearchBarCallbacks {
	onQuery(query: string): void;
	onClear(): void;
	onPick(row: NodeRow): void;
	onOpenNote(path: string): void;
	onToggleControls(): void;
	onFit(): void;
}

/** Shown before a list is cut short; the rest stay highlighted in the graph. */
const MAX_ROWS = 30;

/**
 * Search box over the graph, with its results listed underneath.
 *
 * Results are split the way the search engine finds them: nodes that match
 * the words themselves, and nodes the graph walk reached from those matches.
 * The second group is the point -- it is what the user did not know to search
 * for -- so it is listed with the reason it was reached, not merged into one
 * ranking that would hide the difference.
 */
export class GraphSearchBar {
	readonly el: HTMLElement;
	private readonly input: HTMLInputElement;
	private readonly resultsEl: HTMLElement;
	private collapsed = false;
	private results: SearchResults | null = null;

	constructor(parent: HTMLElement, private readonly callbacks: SearchBarCallbacks) {
		this.el = parent.createDiv({ cls: 'sgb-graph-search' });
		const bar = this.el.createDiv({ cls: 'sgb-graph-search-bar' });

		const field = bar.createDiv({ cls: 'search-input-container sgb-graph-search-field' });
		this.input = field.createEl('input', {
			type: 'search',
			attr: { placeholder: 'Search the graph…', spellcheck: 'false' },
		});
		this.input.addEventListener('input', () => this.callbacks.onQuery(this.input.value));
		this.input.addEventListener('keydown', (evt: KeyboardEvent) => {
			if (evt.key === 'Enter') {
				evt.preventDefault();
				const first = this.results?.matches.find(r => r.id) ?? this.results?.related.find(r => r.id);
				if (first) this.callbacks.onPick(first);
			} else if (evt.key === 'Escape') {
				evt.preventDefault();
				evt.stopPropagation();
				this.clear();
			}
		});
		const clear = field.createDiv({ cls: 'search-input-clear-button', attr: { 'aria-label': 'Clear search' } });
		clear.addEventListener('click', () => this.clear());

		this.iconButton(bar, 'maximize', 'Fit graph to view', () => this.callbacks.onFit());
		this.iconButton(bar, 'sliders-horizontal', 'Display and forces', () => this.callbacks.onToggleControls());

		this.resultsEl = this.el.createDiv({ cls: 'sgb-graph-panel sgb-graph-search-results' });
		this.resultsEl.hide();
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createDiv({ cls: 'clickable-icon sgb-graph-icon-button', attr: { 'aria-label': label } });
		setIcon(button, icon);
		button.addEventListener('click', onClick);
	}

	get query(): string {
		return this.input.value;
	}

	/** Put text in the box without the user typing it, e.g. for "search around". */
	setQuery(query: string): void {
		this.input.value = query;
	}

	clear(): void {
		this.input.value = '';
		this.show(null);
		this.callbacks.onClear();
	}

	show(results: SearchResults | null): void {
		this.results = results;
		this.resultsEl.empty();
		if (!results) {
			this.resultsEl.hide();
			return;
		}
		this.resultsEl.show();

		const header = this.resultsEl.createDiv({ cls: 'sgb-graph-panel-header' });
		const total = results.matches.length + results.related.length;
		header.createSpan({
			cls: 'sgb-graph-panel-title',
			text: results.heading ?? `${total} result${total === 1 ? '' : 's'}`,
		});
		const collapse = header.createDiv({
			cls: 'clickable-icon',
			attr: { 'aria-label': this.collapsed ? 'Show list' : 'Hide list' },
		});
		setIcon(collapse, this.collapsed ? 'chevron-down' : 'chevron-up');
		collapse.addEventListener('click', () => {
			this.collapsed = !this.collapsed;
			this.show(this.results);
		});
		if (this.collapsed) return;

		const body = this.resultsEl.createDiv({ cls: 'sgb-graph-panel-body' });
		if (results.status) body.createDiv({ cls: 'sgb-graph-panel-empty', text: results.status });
		if (total === 0 && !results.status) {
			body.createDiv({ cls: 'sgb-graph-panel-empty', text: 'No matches.' });
		}
		this.group(body, 'Matches', results.matches);
		this.group(body, 'Reached through the graph', results.related);
	}

	private group(parent: HTMLElement, title: string, rows: NodeRow[]): void {
		if (rows.length === 0) return;
		parent.createDiv({ cls: 'sgb-graph-panel-subheading', text: `${title} (${rows.length})` });
		for (const row of rows.slice(0, MAX_ROWS)) {
			renderNodeRow(parent, row, () => this.callbacks.onPick(row), path => this.callbacks.onOpenNote(path));
		}
		if (rows.length > MAX_ROWS) {
			parent.createDiv({
				cls: 'sgb-graph-panel-empty',
				text: `${rows.length - MAX_ROWS} more highlighted in the graph.`,
			});
		}
	}
}

/**
 * A clickable node entry. A node the filters keep out of the view can't be
 * jumped to, so it is shown muted -- a note can still be opened directly.
 */
function renderNodeRow(
	parent: HTMLElement,
	row: NodeRow,
	onPick: () => void,
	onOpenNote: (path: string) => void,
): HTMLElement {
	const item = parent.createDiv({ cls: 'sgb-graph-node-row' });
	if (!row.id) item.addClass('is-hidden');
	const line = item.createDiv({ cls: 'sgb-graph-node-row-line' });
	const swatch = line.createSpan({ cls: 'sgb-graph-swatch' });
	swatch.setCssProps({ '--sgb-swatch-color': row.color });
	line.createSpan({ text: row.name, cls: 'sgb-graph-node-name' });
	line.createSpan({ text: row.type, cls: 'sgb-graph-node-type' });
	if (row.notePath) {
		const path = row.notePath;
		const open = line.createDiv({ cls: 'clickable-icon sgb-graph-open-note', attr: { 'aria-label': 'Open note' } });
		setIcon(open, 'file-text');
		open.addEventListener('click', evt => {
			evt.stopPropagation();
			onOpenNote(path);
		});
	}
	if (row.reason) item.createDiv({ text: row.reason, cls: 'sgb-graph-node-reason' });
	if (row.id) {
		item.addEventListener('click', onPick);
	} else {
		item.setAttr('aria-label', 'Hidden by the graph filters');
	}
	return item;
}

// ============================================
// Inspector
// ============================================

export interface InspectorRelation {
	verb: string;
	/** 'out': this node is the subject; 'in': the other node is. */
	direction: 'out' | 'in';
	other: NodeRow;
	detail?: string;
}

export interface PathStep {
	node: NodeRow;
	/** Edge that led here from the previous step. */
	via?: { verb: string; direction: 'out' | 'in' };
}

export interface InspectorData {
	node: NodeRow;
	description?: string;
	degree: number;
	relations: InspectorRelation[];
	sourceNotes: string[];
	/** Nodes visited before this one, oldest first. */
	trail: NodeRow[];
	focusHops: number;
	/** Set while the user is choosing a node to find a path to. */
	pickingPath: boolean;
	path: PathStep[] | null;
}

export interface InspectorCallbacks {
	onNavigate(row: NodeRow): void;
	onOpenNote(path: string): void;
	onClose(): void;
	onFocusHops(hops: number): void;
	onSearchAround(): void;
	onPathStart(): void;
	onPathCancel(): void;
}

/** Relations listed before "show all"; hubs can have hundreds. */
const MAX_RELATIONS = 40;

/**
 * Details of the selected node, and the ways out of it: every relationship
 * is a link to the node on its other end, every source note opens, and the
 * trail keeps the route the user took so a line of inquiry can be retraced.
 */
export class GraphInspector {
	readonly el: HTMLElement;
	private showAllRelations = false;
	/** Header only, so a narrow pane can show the graph behind it. */
	private collapsed = false;
	private data: InspectorData | null = null;

	constructor(parent: HTMLElement, private readonly callbacks: InspectorCallbacks) {
		this.el = parent.createDiv({ cls: 'sgb-graph-panel sgb-graph-inspector' });
		this.el.hide();
	}

	show(data: InspectorData | null): void {
		if (data?.node.id !== this.data?.node.id) this.showAllRelations = false;
		this.data = data;
		this.el.empty();
		if (!data) {
			this.el.hide();
			return;
		}
		this.el.show();

		const header = this.el.createDiv({ cls: 'sgb-graph-panel-header' });
		const title = header.createDiv({ cls: 'sgb-graph-inspector-title' });
		const swatch = title.createSpan({ cls: 'sgb-graph-swatch' });
		swatch.setCssProps({ '--sgb-swatch-color': data.node.color });
		title.createSpan({ text: data.node.name, cls: 'sgb-graph-panel-title' });
		const buttons = header.createDiv({ cls: 'sgb-graph-panel-buttons' });
		const collapse = buttons.createDiv({
			cls: 'clickable-icon',
			attr: { 'aria-label': this.collapsed ? 'Show details' : 'Hide details' },
		});
		setIcon(collapse, this.collapsed ? 'chevron-up' : 'chevron-down');
		collapse.addEventListener('click', () => {
			this.collapsed = !this.collapsed;
			this.show(this.data);
		});
		const close = buttons.createDiv({ cls: 'clickable-icon', attr: { 'aria-label': 'Close' } });
		setIcon(close, 'x');
		close.addEventListener('click', () => this.callbacks.onClose());
		if (this.collapsed) return;

		const body = this.el.createDiv({ cls: 'sgb-graph-panel-body' });

		if (data.trail.length > 0) this.renderTrail(body, data);

		body.createDiv({
			cls: 'sgb-graph-node-type',
			text: `${data.node.type} · ${data.degree} connection${data.degree === 1 ? '' : 's'}`,
		});
		if (data.description) body.createDiv({ cls: 'sgb-graph-inspector-description', text: data.description });

		this.renderActions(body, data);
		if (data.path) this.renderPath(body, data.path);
		this.renderRelations(body, data);
		this.renderNotes(body, data);
	}

	private renderTrail(parent: HTMLElement, data: InspectorData): void {
		const trail = parent.createDiv({ cls: 'sgb-graph-trail' });
		for (const step of data.trail) {
			const crumb = trail.createSpan({ cls: 'sgb-graph-trail-step', text: step.name });
			if (step.id) crumb.addEventListener('click', () => this.callbacks.onNavigate(step));
			else crumb.addClass('is-hidden');
			trail.createSpan({ cls: 'sgb-graph-trail-sep', text: '›' });
		}
		trail.createSpan({ cls: 'sgb-graph-trail-current', text: data.node.name });
	}

	private renderActions(parent: HTMLElement, data: InspectorData): void {
		const actions = parent.createDiv({ cls: 'sgb-graph-inspector-actions' });

		const focus = actions.createDiv({ cls: 'sgb-graph-segmented', attr: { 'aria-label': 'Show only nearby nodes' } });
		for (const [hops, label] of [[0, 'All'], [1, '1 hop'], [2, '2 hops']] as const) {
			const button = focus.createEl('button', { text: label });
			if (data.focusHops === hops) button.addClass('is-active');
			button.addEventListener('click', () => this.callbacks.onFocusHops(hops));
		}

		const around = actions.createEl('button', { text: 'Search around' });
		around.setAttr('aria-label', 'Rank notes and entities by how closely they connect to this node');
		around.addEventListener('click', () => this.callbacks.onSearchAround());

		if (data.pickingPath) {
			const cancel = actions.createEl('button', { text: 'Cancel path', cls: 'mod-warning' });
			cancel.addEventListener('click', () => this.callbacks.onPathCancel());
			parent.createDiv({
				cls: 'sgb-graph-panel-empty',
				text: 'Click another node, or pick a search result, to see how they connect.',
			});
		} else {
			const path = actions.createEl('button', { text: 'Path to…' });
			path.addEventListener('click', () => this.callbacks.onPathStart());
		}

		if (data.node.notePath) {
			const notePath = data.node.notePath;
			const open = actions.createEl('button', { text: 'Open note', cls: 'mod-cta' });
			open.addEventListener('click', () => this.callbacks.onOpenNote(notePath));
		}
	}

	private renderPath(parent: HTMLElement, path: PathStep[]): void {
		parent.createDiv({ cls: 'sgb-graph-panel-subheading', text: `Path (${path.length - 1} step${path.length === 2 ? '' : 's'})` });
		if (path.length < 2) {
			parent.createDiv({ cls: 'sgb-graph-panel-empty', text: 'No connection between these nodes in the current view.' });
			return;
		}
		const list = parent.createDiv({ cls: 'sgb-graph-path' });
		for (const step of path) {
			if (step.via) {
				list.createDiv({
					cls: 'sgb-graph-path-verb',
					text: step.via.direction === 'out' ? `↓ ${step.via.verb}` : `↑ ${step.via.verb}`,
				});
			}
			renderNodeRow(list, step.node, () => this.callbacks.onNavigate(step.node), path => this.callbacks.onOpenNote(path));
		}
	}

	private renderRelations(parent: HTMLElement, data: InspectorData): void {
		if (data.relations.length === 0) return;
		parent.createDiv({ cls: 'sgb-graph-panel-subheading', text: `Relationships (${data.relations.length})` });

		// Group by verb and direction, most frequent first, so "uses" with
		// thirty objects reads as one line of thought instead of thirty
		const groups = new Map<string, InspectorRelation[]>();
		for (const relation of data.relations) {
			const key = `${relation.direction}\u0000${relation.verb}`;
			const group = groups.get(key);
			if (group) group.push(relation);
			else groups.set(key, [relation]);
		}
		const ordered = [...groups.values()].sort((a, b) => b.length - a.length || a[0].verb.localeCompare(b[0].verb));

		const limit = this.showAllRelations ? Infinity : MAX_RELATIONS;
		let shown = 0;
		for (const group of ordered) {
			if (shown >= limit) break;
			const { verb, direction } = group[0];
			parent.createDiv({
				cls: 'sgb-graph-relation-verb',
				text: direction === 'out' ? `→ ${verb}` : `← ${verb}`,
			});
			for (const relation of group.slice(0, limit - shown)) {
				const row = renderNodeRow(parent, relation.other, () => this.callbacks.onNavigate(relation.other), path => this.callbacks.onOpenNote(path));
				if (relation.detail) row.createDiv({ cls: 'sgb-graph-node-reason', text: relation.detail });
				shown++;
			}
		}
		if (shown < data.relations.length) {
			const more = parent.createEl('button', { text: `Show all ${data.relations.length}`, cls: 'sgb-graph-more' });
			more.addEventListener('click', () => {
				this.showAllRelations = true;
				this.show(this.data);
			});
		}
	}

	private renderNotes(parent: HTMLElement, data: InspectorData): void {
		const notes = data.sourceNotes.filter(path => path !== data.node.notePath);
		if (notes.length === 0) return;
		parent.createDiv({ cls: 'sgb-graph-panel-subheading', text: `Found in (${notes.length})` });
		const list = parent.createDiv({ cls: 'sgb-graph-notes' });
		for (const path of notes) {
			const link = list.createEl('a', { text: noteName(path), cls: 'sgb-graph-note-link' });
			link.setAttr('aria-label', path);
			link.addEventListener('click', evt => {
				evt.preventDefault();
				this.callbacks.onOpenNote(path);
			});
		}
	}
}

function noteName(path: string): string {
	return path.replace(/\.md$/, '').split('/').pop() || path;
}
