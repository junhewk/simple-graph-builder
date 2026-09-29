/**
 * Shared in-memory vault for the query-engine and MCP suites. Not a *.test.ts,
 * so the runner does not execute it directly.
 *
 * Includes an excluded folder (Private/) whose content must never surface,
 * directly or through the graph, and a NOTE node named like an entity.
 */
import { isQueryVisiblePath, VisibilityContext } from '../src/query/visibility';
import type { GraphReader, NoteRecord, VaultSource } from '../src/query/types';
import type { OntologyEdge, OntologyNode } from '../src/types';

export const files = new Map<string, string>([
	['AI/Transformer.md', '---\ntags: [ml]\n---\n# Transformer\nThe transformer architecture relies on attention.'],
	['AI/Attention.md', 'Attention lets models weigh tokens. See [[Transformer]].'],
	['Korean/인공지능.md', '인공지능은 사람의 지능을 모방한다.'],
	['Notes/Unrelated.md', 'Gardening tips for tomatoes.'],
	['Notes/Graph-only.md', 'Some thoughts on sequence models.'],
	['Private/secret.md', 'transformer secrets and the secret project'],
	['Entities/Transformer.md', '---\nsgb-id: concept:transformer\n---\nA neural architecture.'],
	['.obsidian/plugins/x.md', 'transformer config'],
]);
const excluded = (p: string) => p.startsWith('Private/');
export const links: Record<string, Record<string, number>> = {
	'AI/Attention.md': { 'AI/Transformer.md': 1 },
	'Private/secret.md': { 'AI/Transformer.md': 1 },
};

export const ctx: VisibilityContext = {
	configDir: '.obsidian',
	isMarkdownFile: p => files.has(p),
	userExclusion: p => (excluded(p) ? 'excluded' : 'ok'),
};

export const source: VaultSource = {
	listMarkdownPaths: () => [...files.keys()],
	isVisible: p => isQueryVisiblePath(ctx, p),
	readNote: async (p): Promise<NoteRecord | null> => {
		const text = files.get(p);
		if (text === undefined) return null;
		const body = text.replace(/^---\n[\s\S]*?\n---\n?/, '');
		return {
			title: p.split('/').pop()!.replace(/\.md$/, ''),
			aliases: [],
			tags: /tags: \[ml\]/.test(text) ? ['ml'] : [],
			headings: [...body.matchAll(/^#+ (.*)$/gm)].map(m => m[1]),
			body,
		};
	},
	readContent: async p => files.get(p) ?? null,
	resolvedLinks: () => links,
	// Unique basenames only, so the ambiguity path below is exercised.
	resolveLinktext: (link) => {
		const hits = [...files.keys()].filter(p => p.replace(/\.md$/, '').endsWith(link));
		return hits.length === 1 ? hits[0] : null;
	},
	noteMeta: p => ({ tags: /tags: \[ml\]/.test(files.get(p) ?? '') ? ['ml'] : [], aliases: [] }),
};

export const node = (id: string, name: string, type: string, sourceNotes: string[], extra: Record<string, unknown> = {}): OntologyNode =>
	({ id, entityType: type as never, properties: { name, ...extra }, sourceNotes });
export const nodes: OntologyNode[] = [
	node('concept:transformer', 'Transformer', 'CONCEPT', ['AI/Transformer.md', 'Notes/Graph-only.md'],
		{ aliases: ['Transformer model'], description: 'A neural sequence architecture.', entityNotePath: 'Entities/Transformer.md' }),
	node('concept:attention', 'Attention', 'CONCEPT', ['AI/Attention.md'], { description: 'Weighting mechanism.' }),
	node('concept:인공지능', '인공지능', 'CONCEPT', ['Korean/인공지능.md']),
	node('project:secret project', 'Secret Project', 'PROJECT', ['Private/secret.md'], { description: 'Hidden work on transformers.' }),
	// The note layer's NOTE node, named like the entity: must be ignored.
	node('note:ai/transformer.md', 'Transformer', 'NOTE', ['AI/Transformer.md']),
];
export const edges: OntologyEdge[] = [
	{ id: 'e1', source: 'concept:transformer', target: 'concept:attention', relationship: 'uses', properties: { detail: 'self-attention' }, sourceNote: 'AI/Transformer.md' },
	{ id: 'e2', source: 'concept:transformer', target: 'project:secret project', relationship: 'funds', properties: {}, sourceNote: 'Private/secret.md' },
	// Visible endpoints, but the evidence is an excluded note.
	{ id: 'e3', source: 'concept:attention', target: 'concept:인공지능', relationship: 'inspires', properties: {}, sourceNote: 'Private/secret.md' },
	{ id: 'e4', source: 'note:ai/transformer.md', target: 'concept:transformer', relationship: 'mentions', properties: {} },
];
export const state = { revision: 1 };
export const graph: GraphReader = { getRevision: () => state.revision, getAllNodes: () => nodes, getAllEdges: () => edges };

