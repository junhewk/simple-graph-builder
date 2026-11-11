/** Create a small, non-destructive release acceptance vault. Never generates a graph with a model. */
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = process.argv[2];
if (!destination) throw new Error('Usage: node scripts/make-literature-test-vault.mjs /path/to/new-vault');
const out = resolve(destination);
if (existsSync(out) && readdirSync(out).length) throw new Error('Use a new or empty folder. Existing vaults are never overwritten.');
for (const file of ['main.js', 'manifest.json', 'styles.css']) if (!existsSync(join(repo, file))) throw new Error('Run npm run build first.');
const write = (path, text) => { const full = join(out, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
const plugin = '.obsidian/plugins/simple-graph-builder';
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	mkdirSync(join(out, plugin), { recursive: true });
	copyFileSync(join(repo, file), join(out, plugin, file));
}
write('.obsidian/community-plugins.json', JSON.stringify(['simple-graph-builder'], null, 2));
const notes = ['Sources/Simulation.md', 'Sources/Practice.md'];
const nodes = [
	{ id: 'method:simulation', entityType: 'METHOD', properties: { name: 'Simulation', aliases: ['시뮬레이션', 'simulation-based medical education', 'SBME'], description: 'An educational method.' }, sourceNotes: [notes[0]] },
	{ id: 'concept:feedback', entityType: 'CONCEPT', properties: { name: 'Feedback', aliases: ['피드백'], description: 'Information used to guide improvement.' }, sourceNotes: notes },
	{ id: 'method:deliberate practice', entityType: 'METHOD', properties: { name: 'Deliberate practice', aliases: ['의도적 연습'], description: 'Focused repetition with goals and correction.' }, sourceNotes: [notes[1]] },
];
const edges = [
	{ id: 'fixture:provides', source: nodes[0].id, target: nodes[1].id, relationship: 'provides', sourceNote: notes[0], properties: { detail: 'Illustrative passage: simulation activities provide feedback to learners.' } },
	{ id: 'fixture:uses', source: nodes[2].id, target: nodes[1].id, relationship: 'uses', sourceNote: notes[1], properties: { detail: 'Illustrative passage: deliberate practice uses feedback to guide further attempts.' } },
];
write(`${plugin}/data.json`, JSON.stringify({ settings: { settingsVersion: 8, autoAnalyzeOnSave: false, enableEmbeddings: false, mcpEnabled: false, graphShowNotes: false, openGraphInMain: true, showReleaseNotes: false, literaturePageSize: 20, literatureContactEmail: '' }, graph: { version: 3, nodes, edges }, hashes: { hashes: [] } }, null, 2));
write(notes[0], '---\npmid: 21900138\ndoi: 10.1001/jama.2011.1234\n---\n# Simulation\n\nThis release fixture uses an illustrative passage, not a quotation from the linked publication.\n\nSimulation activities provide feedback to learners.\n\nPublication for identifier matching: [Cook and colleagues, 2011](https://pubmed.ncbi.nlm.nih.gov/21900138/).\n');
write(notes[1], '---\npmid: 21512370\npmcid: PMC3102783\ndoi: 10.1097/ACM.0b013e318217e119\n---\n# Practice\n\nThis release fixture uses an illustrative passage, not a quotation from the linked publication.\n\nDeliberate practice uses feedback to guide further attempts.\n\nPublication for identifier matching: [McGaghie and colleagues, 2011](https://pubmed.ncbi.nlm.nih.gov/21512370/).\n');
write('Start.md', '# Literature search acceptance fixture\n\nThe graph is already prepared. No analysis, agent, external backend or model key is needed.\n\n1. Open the knowledge graph and search `Simulation`.\n2. Select Simulation. Compare **1 hop** (Feedback) and **2 hops** (Deliberate practice).\n3. Follow `provides` to Feedback and `← uses` to Deliberate practice. Expand supporting sources and read their illustrative passages.\n4. Invoke **Find more literature…**. Verify both relationship directions and the original search are visible.\n5. Keep `Deliberate practice`, then add a required concept with the expression `medical education`. Search both sources.\n6. Inspect a returned abstract and the exact source queries. Open one publication in the external browser.\n7. Verify the source notes and graph records are unchanged.\n\nThe reverse second edge is intentional. The discovery target does not contain the starting keyword in its name, aliases or description. See [[Examples/Saved results]] for offline examples.\n');
write('Examples/Saved results.md', '# Saved example results — synthetic, offline only\n\nThese examples are not live API results and do not claim to describe real publications. Live search never substitutes them for a failed request.\n\n- **Practice and feedback** — synthetic citation, 2025; abstract: “Feedback supports practice.”\n- **A paper without an abstract** — synthetic citation, 2024; abstract not supplied.\n- **An identifier-free Korean example: 의도적 연습** — synthetic citation, 2026; no DOI or PMID.\n\nMachine-readable versions are in the repository’s `tests/fixtures/literature` directory.\n');
console.log(`Created literature acceptance vault: ${out}`);
