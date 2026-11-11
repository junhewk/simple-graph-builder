import assert from 'node:assert/strict';
import { captureGraphContext, describeGraphRoute, ExplorationTrail } from '../src/literature/context';
import { readVaultReferences } from '../src/literature/vault-index';
import { TFile } from './obsidian-stub';
import type { OntologyNode, OntologyEdge } from '../src/types';
import { DEFAULT_SETTINGS, CURRENT_SETTINGS_VERSION } from '../src/settings';
import { migrateSettings } from '../src/settings-migration';

const nodes: OntologyNode[] = [
	{ id: 'a', entityType: 'CONCEPT', properties: { name: '의학교육', aliases: ['medical education'] }, sourceNotes: ['Sources/A.md'] },
	{ id: 'b', entityType: 'METHOD', properties: { name: 'Simulation' }, sourceNotes: ['Sources/A.md', 'Sources/B.md'] },
	{ id: 'c', entityType: 'METHOD', properties: { name: 'Deliberate practice', aliases: ['의도적 연습'] }, sourceNotes: ['Sources/B.md'] },
];
const edges: OntologyEdge[] = [
	{ id: 'ab', source: 'a', target: 'b', relationship: 'includes', sourceNote: 'Sources/A.md', properties: { detail: 'An ordinary extraction detail, not a quotation.' } },
	{ id: 'cb', source: 'c', target: 'b', relationship: 'supports', sourceNote: 'Sources/B.md', properties: { medLit: { project1: { relIds: [7], evidence: [{ note: 'Sources/B.md', quote: 'Synthetic supporting quote.' }] } } } },
];
const files = ['Sources/A.md', 'Sources/B.md', 'Private/Hidden.md'].map(path => Object.assign(new TFile(), { path, basename: path.split('/').pop()!.replace('.md', '') }));
const plugin: any = {
	app: { vault: { getMarkdownFiles: () => files }, metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: file.path.endsWith('A.md') ? { doi: '10.1234/a', pmid: 10001 } : {} }) } },
	querySource: { isVisible: (path: string) => !path.startsWith('Private/') },
	imports: { all: () => [{ files: { 'source:pubmed:10002': { path: 'Sources/B.md' }, 'source:pubmed:99999': { path: 'Private/Hidden.md' } } }] },
	graphCache: { getAllNodes: () => nodes, getNodeById: (id: string) => nodes.find(node => node.id === id), getEdgeById: (id: string) => edges.find(edge => edge.id === id), getRevision: () => 42 },
};
const before = JSON.stringify({ nodes, edges, files });
const refs = readVaultReferences(plugin);
assert.deepEqual(refs.index.find({ pmid: '10001' }), ['Sources/A.md']);
assert.deepEqual(refs.index.find({ pmid: '10002' }), ['Sources/B.md'], 'existing importer identity mappings are reused');
assert.deepEqual(refs.index.find({ pmid: '99999' }), [], 'hidden notes are not indexed');
const trail = new ExplorationTrail();
trail.visit('a'); trail.visit('b', 'ab'); trail.visit('c', 'cb');
const context = captureGraphContext(plugin.graphCache, {
	steps: trail.steps, selectedNodeId: 'c', originalSearch: 'medical education', discovery: 'propagation',
	neighborhood: { anchorNodeId: 'c', hops: 2 }, distanceFromStart: 2,
	scope: { includesNoteNodes: false, filtered: false, truncated: false },
}, path => refs.reference(path));
assert.equal(context.startingNodeId, 'a');
assert.equal(context.selectedNodeId, 'c');
assert.equal(context.originalSearch, 'medical education');
assert.equal(context.discovery, 'propagation', 'a measured distance does not relabel propagation as a fixed-hop search');
assert.equal(context.distanceFromStart, 2);
assert.equal(context.route[1].via?.direction, 'out');
assert.equal(context.route[2].via?.direction, 'in');
assert.equal(context.route[2].via?.edgeId, 'cb');
assert.equal(context.route[2].via?.source, 'c');
assert.equal(describeGraphRoute(context), '의학교육 —includes→ Simulation ←supports— Deliberate practice');
assert.ok(context.route[2].via?.evidence.some(ref => ref.quote === 'Synthetic supporting quote.' && ref.identifiers.pmid === '10002'));
assert.equal(context.route[1].via?.evidence[0].quote, undefined, 'relationship details do not become verbatim quotations');
assert.deepEqual(context.nodes[0].aliases, ['medical education']);
assert.equal(JSON.stringify({ nodes, edges, files }), before, 'capture and vault matching do not modify graph or notes');
nodes[0].properties.aliases!.push('later alias');
assert.deepEqual(context.nodes[0].aliases, ['medical education'], 'origin is a snapshot, not a mutable graph reference');
trail.visit('a');
assert.deepEqual(trail.steps, [{ nodeId: 'a', edgeId: undefined }], 'back navigation rewinds the actual traversal');
trail.visit('c');
const jumped = captureGraphContext(plugin.graphCache, { steps: trail.steps, selectedNodeId: 'c', discovery: 'selection', scope: context.scope }, path => refs.reference(path));
assert.equal(jumped.route[1].via?.kind, 'jump', 'unrelated selection does not invent a graph edge');
assert.equal(describeGraphRoute(jumped), '의학교육 · selected → Deliberate practice');
for (let i = 0; i < 150; i++) trail.visit(`n${i}`);
assert.equal(trail.steps[0].nodeId, 'a');
assert.equal(trail.steps.length, 128);
assert.equal(trail.truncated, true);
assert.equal(trail.steps[1].edgeId, undefined);
trail.clear();
assert.equal(trail.truncated, false);
assert.equal(trail.steps.length, 0);
const legacySettings = { ...DEFAULT_SETTINGS, settingsVersion: 7, literaturePageSize: 10000, literatureContactEmail: ' contact@example.org ', apiKeys: { claude: 'existing-extraction-key' }, autoAnalyzeOnSave: true };
const migrated = migrateSettings(legacySettings, 7).settings;
assert.equal(migrated.settingsVersion, CURRENT_SETTINGS_VERSION);
assert.equal(migrated.literaturePageSize, 20);
assert.equal(migrated.literatureContactEmail, 'contact@example.org');
assert.deepEqual(migrated.apiKeys, { claude: 'existing-extraction-key' });
assert.equal(migrated.autoAnalyzeOnSave, true, 'literature defaults do not change extraction behavior');
assert.equal(migrateSettings(migrated, CURRENT_SETTINGS_VERSION).changed, false);
console.log('ok   literature graph route, direction, ordinary/imported evidence and read-only vault identity');
