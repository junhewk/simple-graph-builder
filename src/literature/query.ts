import { normalizeKey, normalizeUnicode } from '../types';
import { CompiledSearch, LiteratureGraphContext, LiteratureQueryDraft, LiteratureSource } from './types';

/** Starting a search never makes all route nodes required, or all neighbours synonyms. */
export function draftFromContext(context: LiteratureGraphContext): LiteratureQueryDraft {
	const selected = context.nodes.find(n => n.id === context.selectedNodeId);
	return {
		groups: [{ conceptId: selected?.id, expressions: selected ? [selected.name] : [] }],
		sources: ['pubmed', 'openalex'], from: '', to: '', pageSize: 20, limit: 100, nativeOverrides: {},
	};
}

function validDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

/** Parenthesize every alternative group; literal terms cannot inject field tags or operators. */
export function compileQuery(draft: LiteratureQueryDraft, source: LiteratureSource): CompiledSearch {
	if ((draft.from || draft.to) && (!validDate(draft.from) || !validDate(draft.to) || draft.from > draft.to)) {
		throw new Error('Enter both publication dates as YYYY-MM-DD, with the start before the end.');
	}
	if (!Number.isInteger(draft.pageSize) || draft.pageSize < 1 || draft.pageSize > 50 ||
		!Number.isInteger(draft.limit) || draft.limit < draft.pageSize || draft.limit > 100) {
		throw new Error('Use 1–50 results per page and a total limit between the page size and 100.');
	}
	const override = draft.nativeOverrides[source];
	let query: string;
	if (override !== undefined) {
		query = override.trim();
		if (!query) throw new Error('The edited query is empty. Enter a query or reset it from the concepts.');
		if (source === 'openalex' && /\[(?:tiab|title|abstract|title\/abstract|mesh(?: terms)?|mh|pt|dp|pdat|la|tw|all fields)\]/i.test(query)) {
			throw new Error('OpenAlex does not accept PubMed field tags. Edit its query separately or reset it from concepts.');
		}
		validateBrackets(query);
	} else {
		if (draft.groups.length < 1 || draft.groups.length > 4) throw new Error('Choose between one and four required concepts.');
		query = draft.groups.map(group => {
			const seen = new Set<string>();
			const expressions = group.expressions.map(s => normalizeUnicode(s).trim()).filter(s => {
				const key = normalizeKey(s);
				if (!key || seen.has(key)) return false;
				seen.add(key);
				return true;
			});
			if (expressions.length < 1 || expressions.length > 5) throw new Error('Each concept needs one to five alternative expressions.');
			return '(' + expressions.map(expression => {
				if (expression.length > 200 || /["\\\[\]\r\n]/.test(expression)) {
					throw new Error('Use plain expressions up to 200 characters, without quotes, brackets or backslashes. Use a source query edit for native syntax.');
				}
				return `"${expression}"${source === 'pubmed' ? '[tiab]' : ''}`;
			}).join(' OR ') + ')';
		}).join(' AND ');
	}
	// Leave room for encoded API parameters below OpenAlex's supported URL limit.
	if (encodeURIComponent(query).length > 6000) throw new Error('The query is too long. Remove some expressions before searching.');
	return { source, query, from: draft.from, to: draft.to, pageSize: draft.pageSize, limit: draft.limit,
		sort: 'relevance', scope: override === undefined ? 'title/abstract' : 'provider-native query' };
}

function validateBrackets(query: string): void {
	let quoted = false;
	let depth = 0;
	for (let i = 0; i < query.length; i++) {
		const char = query[i];
		if (char === '"' && query[i - 1] !== '\\') quoted = !quoted;
		if (quoted) continue;
		if (char === '(') depth++;
		if (char === ')' && --depth < 0) throw new Error('The edited query has unbalanced parentheses.');
	}
	if (quoted || depth !== 0) throw new Error('The edited query has unbalanced quotes or parentheses.');
}
