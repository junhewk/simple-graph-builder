import { LiteratureHttp } from './http';
import { OpenAlexAdapter } from './providers/openalex';
import { PubMedAdapter } from './providers/pubmed';
import type {
	CompiledSearch, LiteratureAdapter, LiteratureCredentials, LiteraturePage, LiteratureSearchState,
	LiteratureSource, PageToken, SourceSearchState,
} from './types';

interface CacheEntry { at: number; page: LiteraturePage }

/** Shared transport/cache; each pane owns an independent, disposable search session. */
export class LiteratureService {
	private cache = new Map<string, CacheEntry>();
	private sessions = new Set<LiteratureSession>();
	private readonly adapters: Record<LiteratureSource, LiteratureAdapter>;

	constructor(adapters?: Record<LiteratureSource, LiteratureAdapter>, private readonly now: () => number = Date.now) {
		const http = new LiteratureHttp();
		this.adapters = adapters ?? { pubmed: new PubMedAdapter(http), openalex: new OpenAlexAdapter(http) };
	}

	createSession(update: (state: LiteratureSearchState) => void): LiteratureSession {
		const session: LiteratureSession = new LiteratureSession((spec, credentials, active, token) => this.page(spec, credentials, active, token), update,
			() => this.sessions.delete(session));
		this.sessions.add(session);
		return session;
	}

	clearCache(): void { this.cache.clear(); }
	dispose(): void {
		for (const session of [...this.sessions]) session.dispose();
		this.cache.clear();
	}

	private async page(spec: CompiledSearch, credentials: LiteratureCredentials, active: () => boolean, token?: PageToken): Promise<{ page: LiteraturePage; cached: boolean; at: string }> {
		// Public metadata only. Keys/contact details are never stored in the cache key or results.
		const key = JSON.stringify([spec, token]);
		const cached = this.cache.get(key);
		if (cached && this.now() - cached.at < 10 * 60 * 1000) {
			this.cache.delete(key);
			this.cache.set(key, cached);
			return { page: cached.page, cached: true, at: new Date(cached.at).toISOString() };
		}
		const page = await this.adapters[spec.source].search(spec, credentials, active, token);
		const at = this.now();
		if (active()) {
			this.cache.set(key, { page, at });
			// Bound both page count and actual records (a page may contain 50 records).
			while (this.cache.size > 25 || [...this.cache.values()].reduce((count, entry) => count + entry.page.records.length, 0) > 500) {
				const oldest = this.cache.keys().next().value as string | undefined;
				if (oldest === undefined) break;
				this.cache.delete(oldest);
			}
		}
		return { page, cached: false, at: new Date(at).toISOString() };
	}
}

type LoadPage = (spec: CompiledSearch, credentials: LiteratureCredentials, active: () => boolean, token?: PageToken) => Promise<{ page: LiteraturePage; cached: boolean; at: string }>;

export class LiteratureSession {
	state: LiteratureSearchState = { startedAt: '', sources: {} };
	private generation = 0;
	private disposed = false;
	private credentials: LiteratureCredentials = { contactEmail: '' };
	private attempted: Partial<Record<LiteratureSource, PageToken | undefined>> = {};
	private sourceGenerations: Partial<Record<LiteratureSource, number>> = {};

	constructor(private readonly loadPage: LoadPage, private readonly update: (state: LiteratureSearchState) => void, private readonly onDispose: () => void) {}

	async start(specs: CompiledSearch[], credentials: LiteratureCredentials): Promise<void> {
		if (this.disposed) return;
		this.generation++;
		this.credentials = { ...credentials };
		this.attempted = {};
		this.state = { startedAt: new Date().toISOString(), sources: {} };
		for (const spec of specs) this.state.sources[spec.source] = { spec: { ...spec }, status: 'loading', records: [], warnings: [] };
		this.emit();
		await Promise.all(specs.map(spec => this.load(spec.source)));
	}

	async loadMore(source: LiteratureSource): Promise<void> {
		const state = this.state.sources[source];
		if (!state?.next || state.status === 'loading') return;
		await this.load(source, state.next);
	}

	async retry(source: LiteratureSource, credentials?: LiteratureCredentials): Promise<void> {
		if (this.state.sources[source]?.status === 'loading') return;
		if (credentials) this.credentials = { ...credentials };
		await this.load(source, this.attempted[source]);
	}

	stop(): void {
		this.generation++;
		for (const state of Object.values(this.state.sources)) if (state?.status === 'loading') state.status = 'stopped';
		this.emit();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.credentials = { contactEmail: '' };
		this.onDispose();
	}

	private async load(source: LiteratureSource, token?: PageToken): Promise<void> {
		const state = this.state.sources[source];
		if (!state || this.disposed) return;
		const generation = this.generation;
		const sourceGeneration = (this.sourceGenerations[source] ?? 0) + 1;
		this.sourceGenerations[source] = sourceGeneration;
		const active = () => !this.disposed && generation === this.generation && this.sourceGenerations[source] === sourceGeneration;
		this.attempted[source] = token;
		state.status = 'loading';
		state.error = undefined;
		this.emit();
		try {
			const { page, cached, at } = await this.loadPage(state.spec, this.credentials, active, token);
			if (!active()) return;
			const before = token ? state.records : [];
			const seen = new Set(before.map(record => record.sourceRecordId));
			state.records = before.concat(page.records.filter(record => !seen.has(record.sourceRecordId))).slice(0, state.spec.limit);
			state.total = token ? state.total ?? page.total : page.total;
			state.next = page.next;
			state.translation = page.translation ?? state.translation;
			state.warnings = [...new Set(state.warnings.concat(page.warnings))];
			state.cached = cached;
			state.fetchedAt = at;
			state.status = state.records.length ? 'success' : 'empty';
		} catch (error) {
			if (!active()) return;
			state.status = 'error';
			state.error = error instanceof Error ? error.message : 'The literature search failed. Retry this source.';
		}
		this.emit();
	}

	private emit(): void {
		if (this.disposed) return;
		const sources: Partial<Record<LiteratureSource, SourceSearchState>> = {};
		for (const [source, state] of Object.entries(this.state.sources)) {
			if (state) sources[source as LiteratureSource] = { ...state, records: state.records.slice(), warnings: state.warnings.slice() };
		}
		this.update({ startedAt: this.state.startedAt, sources });
	}
}
