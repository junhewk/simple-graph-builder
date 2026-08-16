/**
 * Build a throwaway vault for testing a release, at a realistic size.
 *
 * The point is to exercise migration and write-back against enough data that
 * the effects are visible: a data.json big enough that the reduction shows up
 * in the file size, a graph dense enough to be slow if something is quadratic,
 * and enough Korean to catch a normalization mistake.
 *
 * Everything it seeds can be verified without an API key. The graph is
 * pre-built in the shape 0.5.x persisted, so loading the vault runs the whole
 * migration path, and "Write graph links into notes" makes no model calls.
 *
 *   node scripts/make-test-vault.mjs [outdir] [notes] [entities]
 *
 * See docs/TESTING-0.6.0.md for what to do with the result.
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const OUT = process.argv[2] ?? 'sgb-test-vault';
const NOTE_COUNT = Number(process.argv[3] ?? 120);
const ENTITY_COUNT = Number(process.argv[4] ?? 520);

rmSync(OUT, { recursive: true, force: true });

const write = (rel, text) => {
	const path = join(OUT, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
};

/** Deterministic, so a re-run produces the same vault and the same numbers. */
let seed = 20260816;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = arr => arr[Math.floor(rand() * arr.length)];
const range = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

/** Same cyrb53 the plugin uses, so seeded hashes look like 0.5.x wrote them. */
function computeHash(content, s = 0) {
	let h1 = 0xdeadbeef ^ s, h2 = 0x41c6ce57 ^ s;
	for (let i = 0; i < content.length; i++) {
		const ch = content.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// --- vocabulary ----------------------------------------------------------
const PEOPLE = ['Geoffrey Hinton', 'Yann LeCun', 'Yoshua Bengio', 'Fei-Fei Li', 'Judea Pearl', 'Andrej Karpathy', 'Ilya Sutskever', 'Barbara Liskov', 'Donald Knuth', 'Grace Hopper'];
const ORGS = ['University of Toronto', 'Google DeepMind', 'OpenAI', 'Anthropic', 'MIT', 'Stanford', 'Allen Institute', 'Mila', 'CERN', 'Bell Labs'];
const CONCEPTS = ['Machine Learning', 'Knowledge Graph', 'Entity Resolution', 'Attention', 'Overfitting', 'Generalization', 'Causality', 'Information Retrieval', 'Semantic Search', 'Distributed Representation', 'Transfer Learning', 'Interpretability'];
const METHODS = ['Backpropagation', 'Gradient Descent', 'Beam Search', 'Cross Validation', 'Contrastive Learning', 'Fine Tuning', 'Chunked Extraction', 'Cosine Similarity', 'Bigram Jaccard'];
const TOOLS = ['Obsidian', 'Cytoscape', 'esbuild', 'TypeScript', 'Ollama', 'PyTorch', 'SQLite', 'ripgrep'];
const TOPICS = ['Natural Language Processing', 'Graph Theory', 'Distributed Systems', 'Personal Knowledge Management', 'Information Architecture'];
const DOCS = ['Attention Is All You Need', 'The Bitter Lesson', 'A Mathematical Theory of Communication', 'GraphRAG', 'KGGen'];
const PLACES = ['Toronto', 'Seoul', 'Zurich', 'Mountain View', 'Cambridge'];
const EVENTS = ['NeurIPS 2025', 'ICML 2026', 'Sprint Review', 'Reading Group'];
const PROJECTS = ['Simple Graph Builder', 'Vault Migration', 'Ontology v3', 'Embedding Index'];

// Korean. `머신러닝` and `기계학습` are deliberately absent: they belong to
// Machine Learning as aliases below, and an alias that is also a note title is
// an ambiguity Obsidian resolves in favour of the file, which would muddy the
// one test this vault exists to make clear.
const KO_CONCEPTS = ['딥러닝', '지식그래프', '임베딩', '개체명인식', '자연어처리', '정보검색', '지식관리'];
const KO_PEOPLE = ['김준혁', '이세돌', '세종대왕'];
const KO_ORGS = ['서울대학교', '카이스트', '네이버', '한국과학기술원'];

const TYPED = [
	['PERSON', PEOPLE], ['ORGANIZATION', ORGS], ['CONCEPT', CONCEPTS], ['METHOD', METHODS],
	['TOOL', TOOLS], ['TOPIC', TOPICS], ['DOCUMENT', DOCS], ['PLACE', PLACES],
	['EVENT', EVENTS], ['PROJECT', PROJECTS], ['CONCEPT', KO_CONCEPTS],
	['PERSON', KO_PEOPLE], ['ORGANIZATION', KO_ORGS],
];

// --- entity pool ---------------------------------------------------------
const entities = [];
const seen = new Set();
for (const [type, names] of TYPED) {
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		entities.push({ type, name });
	}
}
// Pad out to the requested size with generated but plausible names.
const SUFFIX = ['Pipeline', 'Index', 'Cache', 'Protocol', 'Benchmark', 'Corpus', 'Heuristic', 'Schema', 'Registry', 'Traversal'];
let n = 0;
while (entities.length < ENTITY_COUNT) {
	const base = pick([...CONCEPTS, ...METHODS, ...TOPICS]);
	const name = `${base} ${pick(SUFFIX)} ${++n}`;
	if (seen.has(name)) continue;
	seen.add(name);
	entities.push({ type: pick(['CONCEPT', 'METHOD', 'TOOL', 'TOPIC', 'PROJECT']), name });
}

const now = 1750000000000;
const nodeId = (type, name) => `${type.toLowerCase()}:${name.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim()}`;

const nodes = entities.map(e => ({
	id: nodeId(e.type, e.name),
	entityType: e.type,
	properties: {
		name: e.name,
		description: `${e.name} appears across these notes; this description stands in for what a model would return.`,
	},
	sourceNotes: [],
	createdAt: now,
	updatedAt: now,
}));
const byId = new Map(nodes.map(node => [node.id, node]));

// The aliases entity resolution would have found. This is what write-back
// carries into Obsidian, so at least one node must have a Korean set.
byId.get(nodeId('CONCEPT', 'Machine Learning')).properties.aliases = ['ML', '머신러닝', '기계학습'];
byId.get(nodeId('CONCEPT', '딥러닝')).properties.aliases = ['deep learning', 'DL'];
byId.get(nodeId('PERSON', 'Geoffrey Hinton')).properties.aliases = ['Hinton', '힌튼'];

// A v2 leftover: the model labelled this "Note", so its id starts with `note:`
// while it is an ordinary entity. Its edges must survive the migration.
const legacyNote = {
	id: 'note:attention is all you need',
	entityType: 'DOCUMENT',
	properties: { name: 'Attention Is All You Need', description: 'The transformer paper, stored under a v2 label-derived id.' },
	sourceNotes: [],
	createdAt: now,
	updatedAt: now,
};
nodes.push(legacyNote);
byId.set(legacyNote.id, legacyNote);

// --- notes ---------------------------------------------------------------
const FOLDERS = ['research', 'meetings', 'daily', '한국어'];
const notePaths = range(NOTE_COUNT, i => `${FOLDERS[i % FOLDERS.length]}/note ${String(i + 1).padStart(3, '0')}.md`);
const noteFiles = new Map();

for (const [i, path] of notePaths.entries()) {
	const korean = path.startsWith('한국어');
	const mine = range(14 + Math.floor(rand() * 12), () => pick(nodes)).filter((v, idx, a) => a.indexOf(v) === idx);
	for (const node of mine) if (!node.sourceNotes.includes(path)) node.sourceNotes.push(path);

	const links = range(2 + Math.floor(rand() * 3), () => pick(notePaths))
		.filter(p => p !== path)
		.filter((v, idx, a) => a.indexOf(v) === idx);

	const names = mine.map(node => node.properties.name);
	const body = korean
		? `# ${path.split('/').pop().replace('.md', '')} 연구 노트\n\n` +
			`${names.slice(0, 5).join(', ')}에 대해 정리한다. ` +
			`${'기계학습'.normalize('NFD')}과 ${'머신러닝'}은 같은 개념으로 취급해야 한다.\n\n` +
			`${names.slice(5, 12).join(', ')} 등이 서로 연결된다.\n\n` +
			links.map(p => `- [[${p.replace('.md', '')}]]`).join('\n') + '\n'
		: `# ${path.split('/').pop().replace('.md', '')}\n\n` +
			`This note discusses ${names.slice(0, 4).join(', ')}. ` +
			`${names[0]} relates to ${names[1] ?? 'the topic above'} in ways worth recording.\n\n` +
			`Later sections mention ${names.slice(4, 11).join(', ')}, which is enough text for the ` +
			`extractor to have something to chew on and enough length to clear the 50-character floor.\n\n` +
			`## Related reading\n\n` +
			links.map(p => `- [[${p.replace('.md', '')}]]`).join('\n') + '\n';

	const frontmatter = `---\ntags: [${korean ? '한국어, ' : ''}test, batch-${(i % 5) + 1}]\n---\n\n`;
	const content = frontmatter + body;
	noteFiles.set(path, content);
	write(path, content);
}

// Notes that exist to be left alone.
const HAND_WRITTEN = `---
related:
  - "[[research/note 001]]"
  - "[[My Reading List]]"
tags: [test, do-not-touch]
---

# A note that already uses a related property

Both entries above are hand written. They must survive "Write graph links into
notes" and "Remove graph links from notes" unchanged.
`;
write('notes/my-related.md', HAND_WRITTEN);

write('notes/tagged.md', `---
tags: [inbox, todo, someday]
aliases: [scratch]
---

Short.
`);

write('Entities/Machine Learning.md', `# My own page about ML

I wrote this by hand, before the plugin ever ran. It must not be overwritten,
and the plugin's own entity note must go somewhere else.
`);

// --- the graph, in the shape 0.5.x persisted it --------------------------
const edges = [];
const edgeId = (s, t, r) => `${s}->${t}:${r}`;
const addEdge = (source, target, relationship, sourceNote) => {
	const id = edgeId(source, target, relationship);
	if (edges.some(e => e.id === id)) return;
	edges.push({ id, source, target, relationship, properties: {}, sourceNote, createdAt: now });
};

const VERBS = ['develops', 'uses', 'cites', 'relates to', 'contains', 'leads to', 'studies'];
const withNotes = nodes.filter(node => node.sourceNotes.length > 0);
for (const node of withNotes) {
	const target = pick(withNotes);
	if (target.id !== node.id) addEdge(node.id, target.id, pick(VERBS), node.sourceNotes[0]);
}
addEdge(legacyNote.id, nodeId('CONCEPT', 'Machine Learning'), 'introduces', notePaths[0]);
legacyNote.sourceNotes.push(notePaths[0]);
const semanticCount = edges.length;

const noteNodes = notePaths.map(path => ({
	id: `note:${path.toLowerCase()}`,
	entityType: 'NOTE',
	properties: { name: path.split('/').pop().replace('.md', ''), path },
	sourceNotes: [path],
	createdAt: now,
	updatedAt: now,
}));

for (const node of nodes) {
	for (const path of node.sourceNotes) addEdge(`note:${path.toLowerCase()}`, node.id, 'mentions', path);
}
for (const [path, content] of noteFiles) {
	for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
		const target = `${match[1]}.md`;
		if (noteFiles.has(target)) addEdge(`note:${path.toLowerCase()}`, `note:${target.toLowerCase()}`, 'links to', path);
	}
}
const noteLayerCount = edges.length - semanticCount;

const data = {
	settings: { apiProvider: 'claude', extractionMode: 'standard' },
	graph: { nodes: [...nodes, ...noteNodes], edges, version: 3 },
	// Whole-file hashes, as written before 0.6.0: these must not trigger a
	// re-analysis, and must be upgraded to body hashes in place.
	hashes: {
		hashes: [...noteFiles].map(([path, content]) => ({ path, hash: computeHash(content), analyzedAt: now })),
	},
};

const serialized = JSON.stringify(data, null, 2);
write('.obsidian/plugins/simple-graph-builder/data.json', serialized);
write('.obsidian/app.json', '{}');
write('.obsidian/community-plugins.json', '["simple-graph-builder"]');

const slim = JSON.stringify({
	...data,
	graph: { nodes, edges: edges.slice(0, semanticCount), version: 3 },
}, null, 2).length;

const kb = b => `${(b / 1024).toFixed(0)} KB`;
console.log(`vault: ${OUT}`);
console.log(`  notes            ${notePaths.length} (+3 special) `);
console.log(`  entities         ${nodes.length}`);
console.log(`  NOTE nodes       ${noteNodes.length}`);
console.log(`  semantic edges   ${semanticCount}`);
console.log(`  note-layer edges ${noteLayerCount}`);
console.log(`  data.json now    ${kb(serialized.length)}`);
console.log(`  expect after     ~${kb(slim)}  (-${(100 * (serialized.length - slim) / serialized.length).toFixed(0)}%)`);
