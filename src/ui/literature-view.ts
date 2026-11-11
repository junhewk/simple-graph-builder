import { ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { describeGraphRoute } from '../literature/context';
import { openArticleExternally } from '../literature/external-links';
import { compileQuery, draftFromContext } from '../literature/query';
import { aggregatePublications, identifierKeys, preferredLink, PublicationHit, safeArticleUrl } from '../literature/results';
import type { LiteratureSession } from '../literature/service';
import {
	CompiledSearch, ConceptGroup, LITERATURE_SOURCES, LiteratureGraphContext, LiteratureQueryDraft,
	LiteratureSearchState, LiteratureSource, PublicationRecord, SOURCE_NAMES, SourceNoteRef,
} from '../literature/types';
import { readVaultReferences, VaultReferenceIndex } from '../literature/vault-index';

export const LITERATURE_VIEW_TYPE = 'simple-graph-literature';

interface QueryPreview { query: HTMLElement; effective: HTMLElement; error: HTMLElement }

/** Session-only, read-only publication search. Workspace state never contains queries or credentials. */
export class LiteratureView extends ItemView {
	private context: LiteratureGraphContext | null = null;
	private draft: LiteratureQueryDraft | null = null;
	private executedContext: LiteratureGraphContext | null = null;
	private executedDraft = '';
	private searchState: LiteratureSearchState = { startedAt: '', sources: {} };
	private readonly session: LiteratureSession;
	private index = new VaultReferenceIndex([]);
	private selectedSource: LiteratureSource = 'pubmed';
	private selectedHit = '';
	private listScroll = 0;
	private originEl: HTMLElement | null = null;
	private originStatus: HTMLElement | null = null;
	private controlsEl: HTMLElement | null = null;
	private controlsPanel: HTMLDetailsElement | null = null;
	private resultsEl: HTMLElement | null = null;
	private dirtyEl: HTMLElement | null = null;
	private searchButton: HTMLButtonElement | null = null;
	private stopButton: HTMLButtonElement | null = null;
	private previews = new Map<LiteratureSource, QueryPreview>();

	constructor(leaf: WorkspaceLeaf, private readonly plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.session = plugin.literature.createSession(state => {
			this.searchState = state;
			this.renderResults();
			this.updatePreviews();
		});
	}

	getViewType(): string { return LITERATURE_VIEW_TYPE; }
	getDisplayText(): string { return 'Literature search'; }
	getIcon(): string { return 'book-open'; }

	onOpen(): Promise<void> {
		this.contentEl.addClass('sgb-literature');
		this.render();
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateOriginStatus()));
		return Promise.resolve();
	}

	setContext(context: LiteratureGraphContext): void {
		this.session.stop();
		this.context = context;
		this.draft = draftFromContext(context);
		this.draft.pageSize = this.plugin.settings.literaturePageSize;
		this.executedContext = null;
		this.executedDraft = '';
		this.searchState = { startedAt: '', sources: {} };
		this.selectedHit = '';
		this.listScroll = 0;
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl('h2', { text: 'Find more literature' });
		if (!this.context || !this.draft) {
			this.contentEl.createEl('p', { text: 'Select a concept or path in the knowledge graph, then choose “Find more literature…”.' });
			return;
		}
		const route = this.contentEl.createDiv({ cls: 'sgb-literature-route-bar' });
		route.createDiv({ cls: 'sgb-literature-label', text: 'Graph origin' });
		route.createDiv({ cls: 'sgb-literature-route', text: describeGraphRoute(this.context) });
		this.originEl = this.contentEl.createEl('details', { cls: 'sgb-literature-origin' });
		this.controlsPanel = this.contentEl.createEl('details', { cls: 'sgb-literature-controls-panel' });
		this.controlsPanel.open = true;
		this.controlsPanel.createEl('summary', { text: 'Search controls' });
		this.controlsEl = this.controlsPanel.createDiv({ cls: 'sgb-literature-controls' });
		this.resultsEl = this.contentEl.createDiv({ cls: 'sgb-literature-results' });
		this.renderOrigin();
		this.renderControls();
		this.renderResults();
	}

	private renderOrigin(): void {
		const el = this.originEl;
		const context = this.context;
		if (!el || !context) return;
		el.empty();
		el.createEl('summary', { text: 'Graph context and supporting sources' });
		if (context.originalSearch) el.createDiv({ text: `Original graph search: ${context.originalSearch}` });
		const name = (id: string) => context.nodes.find(node => node.id === id)?.name ?? id;
		const discovery = { selection: 'Selected concept', neighborhood: 'Neighborhood exploration', propagation: 'Reached through graph propagation', 'shortest-path': 'Shortest path in the captured view' };
		el.createDiv({ cls: 'sgb-literature-muted', text: discovery[context.discovery] +
			(context.distanceFromStart !== undefined ? ` · ${context.distanceFromStart} hop(s) from the starting node in that view` : '') });
		if (context.neighborhood) el.createDiv({ cls: 'sgb-literature-muted', text: `Explicit neighborhood control: up to ${context.neighborhood.hops} hop(s) around ${name(context.neighborhood.anchorNodeId)}.` });
		if (context.scope.filtered || context.scope.truncated) el.createDiv({ cls: 'sgb-literature-muted', text: 'The captured graph view was filtered or limited; the route does not describe every possible connection.' });
		if (context.scope.includesNoteNodes) el.createDiv({ cls: 'sgb-literature-muted', text: 'This view includes note nodes; mentions and note links count as graph steps.' });
		if (context.historyTruncated) el.createDiv({ cls: 'sgb-literature-muted', text: 'Earlier navigation history was shortened. Selection jumps are not relationship evidence.' });
		this.originStatus = el.createDiv({ cls: 'sgb-literature-muted' });
		this.updateOriginStatus();
		const evidence = el.createEl('details');
		evidence.createEl('summary', { text: 'Relationships and supporting source notes' });
		for (const step of context.route) {
			if (step.via?.kind !== 'relationship') continue;
			const relation = evidence.createDiv({ cls: 'sgb-literature-evidence' });
			relation.createDiv({ text: `${name(step.via.source ?? '')} —${step.via.verb}→ ${name(step.via.target ?? '')}` });
			if (step.via.detail) relation.createDiv({ text: step.via.detail, cls: 'sgb-literature-muted' });
			if (!step.via.evidence.length) relation.createDiv({ text: 'No supporting source note recorded.', cls: 'sgb-literature-muted' });
			for (const ref of step.via.evidence) this.renderReference(relation, ref);
		}
		const refs = new Map(context.nodes.flatMap(node => node.sourceNotes).map(ref => [ref.path, ref]));
		if (refs.size) {
			evidence.createDiv({ cls: 'sgb-literature-label', text: 'Concept source notes' });
			for (const ref of refs.values()) this.renderReference(evidence, ref);
		}
		const question = el.createEl('label', { cls: 'sgb-literature-field' });
		question.createSpan({ text: 'Research question (optional context; not sent to the sources)' });
		const input = question.createEl('textarea', { attr: { rows: '2', placeholder: 'What would you like to understand next?' } });
		input.value = context.researchQuestion ?? '';
		input.addEventListener('input', () => { context.researchQuestion = input.value; });
	}

	private renderReference(parent: HTMLElement, ref: SourceNoteRef): void {
		const row = parent.createDiv({ cls: 'sgb-literature-reference' });
		const button = row.createEl('button', { text: ref.path, cls: 'sgb-literature-note' });
		button.addEventListener('click', () => void this.openNote(ref.path));
		if (ref.quote) row.createEl('blockquote', { text: ref.quote });
		const ids = identifierKeys(ref.identifiers);
		if (ids.length) row.createDiv({ text: ids.join(' · '), cls: 'sgb-literature-muted' });
	}

	private updateOriginStatus(): void {
		if (this.originStatus && this.context) this.originStatus.setText(this.plugin.graphCache.getRevision() === this.context.graphRevision
			? `Captured ${new Date(this.context.capturedAt).toLocaleString()}`
			: 'The graph has changed since this origin was captured. Invoke the action in the graph again to capture a new origin.');
	}

	private renderControls(): void {
		const el = this.controlsEl;
		const draft = this.draft;
		if (!el || !draft || !this.context) return;
		el.empty();
		el.createDiv({ cls: 'sgb-literature-label', text: 'Search concepts' });
		el.createDiv({ cls: 'sgb-literature-muted', text: 'Alternative expressions within a concept use OR. Separately required concepts use AND. Connected concepts are not automatically synonyms.' });
		for (const [index, group] of draft.groups.entries()) this.renderGroup(el, group, index);
		const addRow = el.createDiv({ cls: 'sgb-literature-inline' });
		const picker = addRow.createEl('select', { attr: { 'aria-label': 'Concept to require' } });
		picker.createEl('option', { text: 'New concept (type your own expressions)', value: '' });
		for (const node of this.context.nodes) {
			if (!draft.groups.some(group => group.conceptId === node.id)) picker.createEl('option', { text: node.name, value: node.id });
		}
		const add = addRow.createEl('button', { text: 'Add required concept (AND)' });
		add.disabled = draft.groups.length >= 4;
		add.addEventListener('click', () => {
			const node = this.context?.nodes.find(n => n.id === picker.value);
			draft.groups.push({ conceptId: node?.id, expressions: node ? [node.name] : [] });
			this.renderControls();
		});
		const sources = el.createDiv({ cls: 'sgb-literature-inline' });
		for (const source of LITERATURE_SOURCES) {
			const label = sources.createEl('label');
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = draft.sources.includes(source);
			label.createSpan({ text: SOURCE_NAMES[source] });
			input.addEventListener('change', () => {
				draft.sources = LITERATURE_SOURCES.filter(s => s === source ? input.checked : draft.sources.includes(s));
				this.updatePreviews();
			});
		}
		const filters = el.createDiv({ cls: 'sgb-literature-inline' });
		for (const [key, label] of [['from', 'Publication date from'], ['to', 'Through']] as const) {
			const field = filters.createEl('label', { text: label });
			const input = field.createEl('input', { type: 'date' });
			input.value = draft[key];
			input.addEventListener('change', () => { draft[key] = input.value; this.updatePreviews(); });
		}
		const sizeLabel = filters.createEl('label', { text: 'Per source / page' });
		const size = sizeLabel.createEl('select');
		for (const count of [10, 20, 50]) size.createEl('option', { text: String(count), value: String(count) });
		size.value = String(draft.pageSize);
		size.addEventListener('change', () => { draft.pageSize = Number(size.value); this.updatePreviews(); });
		el.createDiv({ cls: 'sgb-literature-muted', text: 'At most 100 records per source. Dates use each provider’s publication-date definition. No language, access or publication-type filter is applied by the builder.' });
		this.previews.clear();
		for (const source of LITERATURE_SOURCES) this.renderPreview(el, source);
		const actions = el.createDiv({ cls: 'sgb-literature-inline' });
		this.searchButton = actions.createEl('button', { text: 'Search', cls: 'mod-cta' });
		this.searchButton.addEventListener('click', () => void this.search());
		this.stopButton = actions.createEl('button', { text: 'Stop' });
		this.stopButton.addEventListener('click', () => this.session.stop());
		this.dirtyEl = el.createDiv({ cls: 'sgb-literature-muted' });
		el.createDiv({ cls: 'sgb-literature-muted', text: 'Only the displayed queries and filters are sent to the selected sources. Source passages, vault paths and the research question stay in Obsidian.' });
		this.updatePreviews();
	}

	private renderGroup(parent: HTMLElement, group: ConceptGroup, index: number): void {
		const node = this.context?.nodes.find(n => n.id === group.conceptId);
		const el = parent.createEl('fieldset', { cls: 'sgb-literature-group' });
		el.createEl('legend', { text: `${index ? 'AND · ' : ''}${node?.name ?? `Concept ${index + 1}`} (alternatives: OR)` });
		const expressions = [...new Set([...(node ? [node.name, ...node.aliases] : []), ...group.expressions])];
		for (const expression of expressions) {
			const label = el.createEl('label', { cls: 'sgb-literature-expression' });
			const input = label.createEl('input', { type: 'checkbox' });
			input.checked = group.expressions.includes(expression);
			label.createSpan({ text: expression });
			input.addEventListener('change', () => {
				group.expressions = input.checked ? [...group.expressions, expression] : group.expressions.filter(term => term !== expression);
				this.updatePreviews();
			});
		}
		const row = el.createDiv({ cls: 'sgb-literature-inline' });
		const input = row.createEl('input', { type: 'text', attr: { placeholder: 'Another expression for this concept', 'aria-label': 'Alternative expression' } });
		const add = row.createEl('button', { text: 'Add OR term' });
		const addTerm = () => {
			if (!input.value.trim()) return;
			group.expressions.push(input.value.trim());
			this.renderControls();
		};
		add.addEventListener('click', addTerm);
		input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addTerm(); } });
		const remove = row.createEl('button', { text: 'Remove concept' });
		remove.addEventListener('click', () => { this.draft?.groups.splice(index, 1); this.renderControls(); });
	}

	private renderPreview(parent: HTMLElement, source: LiteratureSource): void {
		if (!this.draft) return;
		const el = parent.createEl('details', { cls: 'sgb-literature-query' });
		el.open = true;
		el.createEl('summary', { text: `${SOURCE_NAMES[source]} query` });
		const query = el.createEl('pre');
		const effective = el.createDiv({ cls: 'sgb-literature-muted' });
		const error = el.createDiv({ cls: 'sgb-literature-error', attr: { role: 'status' } });
		this.previews.set(source, { query, effective, error });
		const override = this.draft.nativeOverrides[source];
		if (override !== undefined) {
			el.createDiv({ cls: 'sgb-literature-muted', text: 'Manual source query: concept edits will not overwrite this text. Native filters in this text also apply.' });
			const input = el.createEl('textarea', { attr: { rows: '3', 'aria-label': `Edit ${SOURCE_NAMES[source]} query` } });
			input.value = override;
			input.addEventListener('input', () => { if (this.draft) this.draft.nativeOverrides[source] = input.value; this.updatePreviews(); });
			const reset = el.createEl('button', { text: 'Reset from concepts' });
			reset.addEventListener('click', () => { if (this.draft) delete this.draft.nativeOverrides[source]; this.renderControls(); });
		} else {
			const edit = el.createEl('button', { text: 'Edit source query' });
			edit.addEventListener('click', () => {
				if (!this.draft) return;
				try { this.draft.nativeOverrides[source] = compileQuery(this.draft, source).query; }
				catch { this.draft.nativeOverrides[source] = ''; }
				this.renderControls();
			});
		}
	}

	private updatePreviews(): void {
		if (!this.draft) return;
		let valid = this.draft.sources.length > 0;
		for (const source of LITERATURE_SOURCES) {
			const preview = this.previews.get(source);
			if (!preview) continue;
			try {
				const spec = compileQuery(this.draft, source);
				preview.query.setText(spec.query);
				preview.error.setText('');
				preview.effective.setText(`${this.draft.sources.includes(source) ? 'Selected' : 'Not selected'} · ${spec.scope} · provider relevance order · ${spec.from ? `${spec.from} through ${spec.to}` : 'all dates'} · ${spec.pageSize}/page · cap ${spec.limit}`);
			} catch (error) {
				preview.query.setText(this.draft.nativeOverrides[source] ?? '');
				preview.error.setText(error instanceof Error ? error.message : 'Check this query.');
				if (this.draft.sources.includes(source)) valid = false;
			}
		}
		if (this.searchButton) this.searchButton.disabled = !valid;
		if (this.stopButton) this.stopButton.disabled = !Object.values(this.searchState.sources).some(state => state?.status === 'loading');
		this.dirtyEl?.setText(this.executedDraft && this.executedDraft !== JSON.stringify(this.draft)
			? 'Controls changed. Results below still belong to the previous submitted queries; press Search to run the new queries.'
			: !this.draft.sources.length ? 'Select at least one source.' : '');
	}

	private async search(): Promise<void> {
		if (!this.draft || !this.context) return;
		try {
			if (!this.draft.sources.length) throw new Error('Select at least one source.');
			const specs: CompiledSearch[] = this.draft.sources.map(source => compileQuery(this.draft!, source));
			this.index = readVaultReferences(this.plugin).index;
			this.executedContext = { ...this.context };
			this.executedDraft = JSON.stringify(this.draft);
			this.selectedHit = '';
			this.listScroll = 0;
			this.selectedSource = this.draft.sources[0];
			if (this.controlsPanel) this.controlsPanel.open = false;
			const pending = this.session.start(specs, this.plugin.literatureCredentials.read(this.plugin.settings.literatureContactEmail));
			this.resultsEl?.scrollIntoView({ block: 'start' });
			await pending;
		} catch (error) { new Notice(error instanceof Error ? error.message : 'Could not start the literature search.'); }
	}

	private renderResults(): void {
		const el = this.resultsEl;
		if (!el) return;
		el.empty();
		this.updateOriginStatus();
		if (!this.executedContext) {
			el.createEl('p', { text: 'Review the concepts and queries, then press Search. No literature request has been sent.' });
			return;
		}
		el.createDiv({ cls: 'sgb-literature-label', text: `Results · submitted ${new Date(this.searchState.startedAt).toLocaleString()}` });
		const tabs = el.createDiv({ cls: 'sgb-literature-inline', attr: { 'aria-label': 'Results by source' } });
		for (const source of LITERATURE_SOURCES) {
			const state = this.searchState.sources[source];
			if (!state) continue;
			const tab = tabs.createEl('button', { text: `${SOURCE_NAMES[source]} (${state.records.length})`, cls: source === this.selectedSource ? 'mod-cta' : '' });
			tab.setAttr('aria-pressed', String(source === this.selectedSource));
			tab.addEventListener('click', () => { this.selectedSource = source; this.selectedHit = ''; this.listScroll = 0; this.renderResults(); });
			if (state.status === 'error' && source !== this.selectedSource) tabs.createSpan({ text: `${SOURCE_NAMES[source]} failed; other results remain available.`, cls: 'sgb-literature-error' });
		}
		const state = this.searchState.sources[this.selectedSource];
		if (!state) return;
		const status = el.createDiv({ cls: 'sgb-literature-status', attr: { role: 'status', 'aria-live': 'polite' } });
		if (state.status === 'loading') {
			status.createDiv({ text: `Loading ${SOURCE_NAMES[this.selectedSource]}…` });
			status.createEl('button', { text: 'Stop search' }).addEventListener('click', () => this.session.stop());
		}
		if (state.status === 'error') {
			status.createDiv({ text: state.error ?? 'This source failed.', cls: 'sgb-literature-error' });
			status.createEl('button', { text: 'Retry source' }).addEventListener('click', () => void this.session.retry(this.selectedSource, this.plugin.literatureCredentials.read(this.plugin.settings.literatureContactEmail)));
		}
		if (state.status === 'stopped') {
			status.createDiv({ text: 'Search stopped. Late responses will not replace these results.' });
			status.createEl('button', { text: 'Retry source' }).addEventListener('click', () => void this.session.retry(this.selectedSource, this.plugin.literatureCredentials.read(this.plugin.settings.literatureContactEmail)));
		}
		if (state.status === 'empty') status.createDiv({ text: 'No publications found. Try removing a required concept or date restriction, or choose a different alias, then press Search.' });
		if (state.total !== undefined) status.createDiv({ text: `${state.records.length} records loaded of ${state.total.toLocaleString()} reported · cap ${state.spec.limit} per source`, cls: 'sgb-literature-muted' });
		if (state.fetchedAt) status.createDiv({ text: `${state.cached ? 'Cached response' : 'Retrieved'} ${new Date(state.fetchedAt).toLocaleString()}`, cls: 'sgb-literature-muted' });
		const submitted = status.createEl('details');
		submitted.createEl('summary', { text: 'Exact submitted query and effective controls' });
		submitted.createEl('pre', { text: state.spec.query });
		submitted.createDiv({ text: `${state.spec.scope} · ${state.spec.from ? `${state.spec.from} through ${state.spec.to}` : 'all dates'} · provider relevance · ${state.spec.pageSize}/page · cap ${state.spec.limit}` });
		if (state.translation) submitted.createDiv({ text: `PubMed translation: ${state.translation}` });
		for (const warning of state.warnings) status.createDiv({ text: warning, cls: 'sgb-literature-muted' });
		const allRecords = Object.values(this.searchState.sources).flatMap(source => source?.records ?? []);
		const hits = aggregatePublications(allRecords).filter(hit => hit.records.some(record => record.source === this.selectedSource));
		hits.sort((a, b) => this.sourceRank(a) - this.sourceRank(b));
		const columns = el.createDiv({ cls: 'sgb-literature-columns' });
		const list = columns.createDiv({ cls: 'sgb-literature-list' });
		list.setAttr('aria-label', `${SOURCE_NAMES[this.selectedSource]} publications`);
		list.setAttr('tabindex', '0');
		list.addEventListener('scroll', () => { this.listScroll = list.scrollTop; });
		const detail = columns.createDiv({ cls: 'sgb-literature-detail' });
		for (const hit of hits) {
			const button = list.createEl('button', { cls: 'sgb-literature-result' });
			button.setAttr('aria-pressed', String(hit.key === this.selectedHit));
			button.createDiv({ text: titleOf(hit.citation), cls: 'sgb-literature-result-title' });
			button.createDiv({ text: [hit.citation.year, hit.citation.venue].filter(Boolean).join(' · ') || 'Year / source not supplied', cls: 'sgb-literature-muted' });
			button.createDiv({ text: hit.records.map(record => SOURCE_NAMES[record.source]).join(' + ') +
				(this.vaultMatches(hit).length ? ' · Already in vault' : '') +
				(hit.records.some(record => record.abstract.state === 'available') ? ' · Abstract available' : ' · Abstract unavailable'), cls: 'sgb-literature-muted' });
			button.addEventListener('click', () => {
				this.selectedHit = hit.key;
				this.renderResults();
				this.resultsEl?.querySelector('.sgb-literature-detail')?.scrollIntoView({ block: 'nearest' });
			});
		}
		list.scrollTop = this.listScroll;
		const selected = hits.find(hit => hit.key === this.selectedHit);
		if (selected) this.renderDetail(detail, selected);
		else if (hits.length) detail.createEl('p', { text: 'Select a publication to inspect its citation and available abstracts.' });
		if (state.next) {
			const more = el.createEl('button', { text: `Load more from ${SOURCE_NAMES[this.selectedSource]}` });
			more.disabled = state.status === 'loading';
			more.addEventListener('click', () => void this.session.loadMore(this.selectedSource));
		}
		if (this.selectedSource === 'pubmed') el.createEl('a', { text: 'PubMed / NCBI disclaimer and abstract copyright', href: 'https://www.ncbi.nlm.nih.gov/home/about/policies/', cls: 'sgb-literature-muted', attr: { target: '_blank', rel: 'noopener noreferrer' } });
	}

	private sourceRank(hit: PublicationHit): number { return hit.records.find(record => record.source === this.selectedSource)?.sourceRank ?? Infinity; }
	private vaultMatches(hit: PublicationHit): string[] {
		return [...new Set(hit.records.flatMap(record => this.index.find(record.identifiers)))].filter(path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
	}

	private renderDetail(el: HTMLElement, hit: PublicationHit): void {
		el.createEl('h3', { text: titleOf(hit.citation) });
		const link = preferredLink(hit.records);
		if (link) {
			el.createDiv({ text: `${link.label}: ${link.url}`, cls: 'sgb-literature-destination' });
			el.createEl('button', { text: 'Open in external browser', cls: 'mod-cta' }).addEventListener('click', () => this.openExternal(link.url));
		} else el.createDiv({ text: 'No valid article destination supplied.', cls: 'sgb-literature-muted' });
		const matches = this.vaultMatches(hit);
		el.createDiv({ text: matches.length ? 'Already in vault:' : 'No reliable vault match detected.', cls: 'sgb-literature-muted' });
		for (const path of matches) el.createEl('button', { text: path }).addEventListener('click', () => void this.openNote(path));
		if (hit.conflicts.length) el.createDiv({ text: `Source metadata differs: ${hit.conflicts.join(', ')}. Original source values are preserved below.`, cls: 'sgb-literature-muted' });
		for (const record of hit.records) {
			const body = el.createEl('details', { cls: 'sgb-literature-record' });
			body.open = record.abstract.state === 'available' || hit.records.length === 1;
			body.createEl('summary', { text: `${SOURCE_NAMES[record.source]} metadata and abstract · rank ${record.sourceRank} in this source` });
			body.createDiv({ text: titleOf(record) });
			body.createDiv({ text: record.authors === undefined ? 'Authors not supplied' : record.authors.length ? record.authors.join(', ') : 'Author list empty' });
			if (record.authorsTruncated) body.createDiv({ text: 'The source list may truncate this author list.', cls: 'sgb-literature-muted' });
			body.createDiv({ text: `${record.year ?? 'Year not supplied'} · ${record.venue === undefined ? 'Journal / source not supplied' : record.venue || 'Journal / source empty'}` });
			body.createDiv({ text: record.publicationTypes === undefined ? 'Publication type not supplied' : record.publicationTypes.join(', ') || 'Publication type empty' });
			body.createDiv({ text: identifierKeys(record.identifiers).join(' · ') || 'Identifiers not supplied', cls: 'sgb-literature-muted' });
			body.createDiv({ text: `Retrieved ${new Date(record.retrievedAt).toLocaleString()}`, cls: 'sgb-literature-muted' });
			if (record.abstract.state === 'available') {
				for (const section of record.abstract.sections) {
					if (section.label) body.createDiv({ text: section.label, cls: 'sgb-literature-label' });
					body.createEl('p', { text: section.text });
				}
			} else body.createDiv({ text: record.abstract.state === 'missing' ? 'Abstract not supplied by this source.'
				: record.abstract.state === 'empty' ? 'The source supplied an empty abstract.' : record.abstract.message ?? 'The abstract could not be decoded.', cls: 'sgb-literature-muted' });
			for (const access of record.accessLinks) {
				if (!safeArticleUrl(access.url) || access.url === link?.url) continue;
				const button = body.createEl('button', { text: `${access.label} ↗` });
				button.setAttr('aria-label', access.url);
				button.setAttr('title', access.url);
				button.addEventListener('click', () => this.openExternal(access.url));
			}
		}
	}

	private openExternal(url: string): void {
		void openArticleExternally(url).catch(error => new Notice(error instanceof Error ? error.message : 'Could not open the article URL.'));
	}

	private async openNote(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) { new Notice('This source note is no longer available.'); return; }
		await this.app.workspace.openLinkText(file.path, '', 'tab');
	}

	onClose(): Promise<void> {
		this.session.dispose();
		this.contentEl.empty();
		return Promise.resolve();
	}
}

function titleOf(record: PublicationRecord): string { return record.title === undefined ? 'Title not supplied' : record.title || 'Title empty'; }
