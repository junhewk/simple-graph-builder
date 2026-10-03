/**
 * med-lit projects for the import suites: an in-memory folder laid out the way
 * med-lit writes one (pages plus .med-lit/sgb-export.json), and a reader over a
 * real folder on disk.
 *
 * Not a *.test.ts, so the runner won't execute it directly.
 */
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { SnapshotReader } from '../src/import/reader';

export class MemoryReader implements SnapshotReader {
	files = new Map<string, string>();

	set(rel: string, content: string): this {
		this.files.set(rel, content);
		return this;
	}

	delete(rel: string): this {
		this.files.delete(rel);
		return this;
	}

	async listMarkdown(): Promise<string[]> {
		return [...this.files.keys()].filter(p => p.endsWith('.md') && !p.split('/').some(s => s.startsWith('.'))).sort();
	}

	async readText(rel: string): Promise<string | null> {
		return this.files.get(rel) ?? null;
	}
}

/** A reader over a real project folder, for suites that opt in to real data. */
export function diskReader(root: string): SnapshotReader {
	const abs = (rel: string) => nodePath.join(root, ...rel.split('/'));
	return {
		async listMarkdown() {
			const out: string[] = [];
			const walk = (dir: string, prefix: string) => {
				for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
					if (entry.name.startsWith('.')) continue;
					const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
					if (entry.isDirectory()) walk(nodePath.join(dir, entry.name), rel);
					else if (entry.name.endsWith('.md')) out.push(rel);
				}
			};
			walk(root, '');
			return out.sort();
		},
		async readText(rel) {
			try { return fs.readFileSync(abs(rel), 'utf8'); } catch { return null; }
		},
	};
}

export interface FixtureEntity { id: number; name: string; type: string; sgb: string; description?: string; aliases?: [string, string][] }
export interface FixtureArticle { uid: string; title: string; mentions: [number, string | null][] }
export interface FixtureRel { id: number; source: number; target: number; verb: string; detail?: string; evidence: [string, string][] }

export interface FixtureProject {
	id?: string;
	name?: string;
	ontology?: string;
	updatedAt?: string;
	botUpdate?: number;
	entities: FixtureEntity[];
	articles: FixtureArticle[];
	relationships: FixtureRel[];
	merges?: [number, number, string][];
	/** Override page bodies by rel path. */
	bodies?: Record<string, string>;
	format?: string;
	/** Project id written into the export, when it should differ from project.json. */
	exportProjectId?: string;
	/** bot.json as written; defaults to one finished run when botUpdate is set. */
	bot?: Record<string, unknown>;
}

const fm = (fields: Record<string, unknown>) =>
	'---\ngenerator: med-lit-mcp\n' + Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n') + '\n---\n';

const enc = (name: string) => encodeURIComponent(name);

const entityPage = (e: FixtureEntity) => `entities/${e.name}.md`;
const articlePage = (a: FixtureArticle) => `sources/${a.title}.md`;

/** Build a whole project folder the way med-lit lays one out. */
export function buildProject(p: FixtureProject): MemoryReader {
	const at = p.updatedAt ?? '2026-09-30T00:00:00+00:00';
	const exported = {
		format: p.format ?? 'med-lit-sgb/1',
		generator: 'med-lit-mcp test',
		generated_at: at,
		project: { id: p.exportProjectId ?? p.id ?? 'proj1', name: p.name ?? 'Test review', ontology: p.ontology ?? 'med-lit/1' },
		data_updated_at: at,
		bot_update: p.botUpdate ?? null,
		entities: p.entities.map(e => ({
			id: e.id,
			name: e.name,
			type: e.type,
			sgb_type: e.sgb,
			description: e.description ?? '',
			aliases: (e.aliases ?? []).map(([alias, source]) => ({ alias, source })),
			page: entityPage(e),
		})),
		articles: p.articles.map(a => ({ uid: a.uid, title: a.title, page: articlePage(a) })),
		mentions: p.articles.flatMap(a => a.mentions.map(([entity, role]) => ({ article: a.uid, entity, role }))),
		relationships: p.relationships.map(r => ({
			id: r.id,
			source: r.source,
			target: r.target,
			verb: r.verb,
			detail: r.detail ?? null,
			evidence: r.evidence.map(([article, quote]) => ({ article, quote })),
		})),
		merges: (p.merges ?? []).map(([kept, merged, name]) => ({ kept, merged, name, merged_at: at })),
	};

	const reader = new MemoryReader();
	reader.set('.med-lit/project.json', JSON.stringify({ id: p.id ?? 'proj1', name: p.name ?? 'Test review', ontology: p.ontology ?? 'med-lit/1', layout_version: 1 }));
	reader.set('.med-lit/bot.json', JSON.stringify(p.bot ?? {
		active: null,
		history: p.botUpdate ? [{ update: p.botUpdate, outcome: 'finished' }] : [],
	}));
	reader.set('.med-lit/sgb-export.json', JSON.stringify(exported));

	const entityById = new Map(p.entities.map(e => [e.id, e]));
	for (const e of p.entities) {
		const rels = p.relationships.filter(r => r.source === e.id).map(r => {
			const t = entityById.get(r.target)!;
			return `- ${r.verb} [${t.name}](../entities/${enc(t.name)}.md) · ${r.evidence.length} sources`;
		});
		const sources = p.articles.filter(a => a.mentions.some(([id]) => id === e.id))
			.map(a => `- [${a.uid}](../sources/${enc(a.title)}.md)`);
		const rel = entityPage(e);
		reader.set(rel, p.bodies?.[rel] ?? fm({ type: 'entity', entity_id: e.id, entity_type: e.type, sgb_type: e.sgb, ontology: 'med-lit/1', aliases: [] }) +
			`\n# ${e.name}\n\n${e.description ?? ''}\n\n## Relationships\n\n${rels.join('\n')}\n\n## Source Articles\n\n${sources.join('\n')}\n`);
	}
	for (const a of p.articles) {
		const lines = a.mentions.map(([id, role]) => `- [${entityById.get(id)!.name}](../entities/${enc(entityById.get(id)!.name)}.md) · ${role ?? ''}`);
		const rel = articlePage(a);
		reader.set(rel, p.bodies?.[rel] ?? fm({ type: 'source', uid: a.uid, title: a.title }) + `\n# ${a.title}\n\n## Entities\n\n${lines.join('\n')}\n`);
	}
	reader.set('index.md', p.bodies?.['index.md'] ?? fm({ type: 'index', project: p.name ?? 'Test review' }) +
		`\n# Index\n\n${p.entities.map(e => `- [${e.name}](entities/${enc(e.name)}.md)`).join('\n')}\n\nSee [the update log](log.md).\n`);
	reader.set('log.md', fm({ type: 'log' }) + '\n# Log\n');
	return reader;
}
