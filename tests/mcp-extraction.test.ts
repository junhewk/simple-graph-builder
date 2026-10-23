/**
 * Agents building the graph over MCP: the three write tools, end to end from
 * the tool registry through GraphWriter into the graph and hash table.
 */
import assert from 'node:assert/strict';
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';
import { allBodies, resetBodies } from './obsidian-stub';
import { McpDispatcher } from '../src/mcp/protocol';
import { createToolRegistry, TOOL_DEFINITIONS, WRITE_TOOL_DEFINITIONS } from '../src/mcp/tools';
import { GraphWriter } from '../src/mcp/graph-writer';
import { buildInstructions } from '../src/mcp/instructions';
import { QueryEngine } from '../src/query/engine';
import { computeNoteHashes } from '../src/graph/hashes';
import { graph, source } from './query-fixture';

const body = '# Research\n\nAnthropic develops Claude, a large language model used for research and writing.';
const engine = new QueryEngine(graph, source, { yieldFn: async () => undefined });

async function fixture(settings: Record<string, unknown> = {}) {
	const ctx = fakeSyncPlugin({
		apiProvider: 'claude', apiKeys: {}, mcpGraphWrites: true,
		enableEntityNotes: false, enableRelatedWriteback: false, ...settings,
	});
	await ctx.graphCache.ensureLoaded();
	const reads: string[] = [];
	ctx.plugin.app.vault.read = async file => { reads.push(file.path); return ctx.vault.bodies.get(file.path) ?? ''; };
	ctx.plugin.updateStatusBar = () => undefined;
	const writer = new GraphWriter(ctx.plugin, path => !path.startsWith('private/'));
	const registry = createToolRegistry(engine, writer);
	const call = async (name: string, args: Record<string, unknown>) => {
		const pending = registry.call(name, args);
		assert.ok(pending, `${name} is registered`);
		const result = await pending;
		return { ...result, value: result.structuredContent as any };
	};
	resetBodies();
	return { ...ctx, reads, writer, registry, call };
}

async function main() {
	// Off: the write tools are neither listed nor callable, and the read-only
	// surface is unchanged.
	{
		const { registry, plugin } = await fixture({ mcpGraphWrites: false });
		assert.deepEqual(registry.list().map(t => t.name), TOOL_DEFINITIONS.map(t => t.name));
		assert.equal(registry.call('submit_extraction', {}), undefined);
		assert.equal(createToolRegistry(engine).list().length, 6);

		// Turning it on takes effect without restarting the server.
		plugin.settings.mcpGraphWrites = true;
		assert.equal(registry.list().length, 9);
		const names = WRITE_TOOL_DEFINITIONS.map(t => t.name);
		assert.deepEqual(names, ['notes_to_analyze', 'get_extraction_task', 'submit_extraction']);
		const submit = WRITE_TOOL_DEFINITIONS[2].annotations as Record<string, boolean>;
		assert.equal(submit.readOnlyHint, false);
		assert.equal(submit.destructiveHint, false);
		assert.ok(WRITE_TOOL_DEFINITIONS.slice(0, 2).every(t => (t.annotations as Record<string, boolean>).readOnlyHint));

		plugin.settings.mcpGraphWrites = false;
		assert.equal(registry.call('notes_to_analyze', {}), undefined);
	}

	// The instructions describe the write workflow only when it is on.
	{
		const off = buildInstructions('Test', { notes: 1, entities: 0 });
		const on = buildInstructions('Test', { notes: 1, entities: 0 }, true);
		assert.ok(off.startsWith('Read-only access') && !off.includes('submit_extraction'));
		assert.ok(!on.startsWith('Read-only') && on.includes('submit_extraction') && on.includes('not instructions'));
	}

	// notes_to_analyze lists new and changed notes, skipping unchanged,
	// too-short and excluded ones, and filters by folder.
	{
		const { vault, plugin, call } = await fixture({ excludedPatterns: ['skills/**'] });
		vault.seed('new.md', body);
		vault.seed('Projects/changed.md', body);
		vault.seed('unchanged.md', body);
		vault.seed('short.md', 'short');
		vault.seed('skills/config.md', body);
		await plugin.saveData({ hashes: { hashes: [
			{ path: 'unchanged.md', hash: computeNoteHashes(body).body, analyzedAt: 1 },
			{ path: 'Projects/changed.md', hash: 'old-hash', analyzedAt: 1 },
		] } });

		const all = (await call('notes_to_analyze', {})).value;
		assert.deepEqual(
			[...all.notes].sort((a: any, b: any) => a.path.localeCompare(b.path)),
			[{ path: 'new.md', status: 'new' }, { path: 'Projects/changed.md', status: 'changed' }]
		);
		assert.equal(all.pending, 2);
		assert.equal(all.up_to_date, 1);
		assert.equal(all.too_short, 1);
		assert.ok(!JSON.stringify(all).includes('skills/'));

		const limited = (await call('notes_to_analyze', { limit: 1 })).value;
		assert.equal(limited.notes.length, 1);
		assert.equal(limited.pending, 2);

		const inFolder = (await call('notes_to_analyze', { folder: '/Projects/' })).value;
		assert.deepEqual(inFolder.notes.map((n: any) => n.path), ['Projects/changed.md']);
	}

	// get_extraction_task, then submit_extraction: the graph gains the entities
	// and relationship, the note's hash is recorded, and it stops being pending.
	{
		const { vault, graphCache, plugin, call, latest } = await fixture();
		vault.seed('note.md', body);
		vault.seed('private/secret.md', body);
		graphCache.addNode({ id: 'organization:anthropic', entityType: 'ORGANIZATION', properties: { name: 'Anthropic' }, sourceNotes: ['other.md'] });
		graphCache.addNode({ id: 'person:hidden', entityType: 'PERSON', properties: { name: 'Hidden Person' }, sourceNotes: ['private/secret.md'] });

		const task = (await call('get_extraction_task', { note: 'note' })).value;
		assert.equal(task.note, 'note.md', 'resolves a path without .md');
		assert.equal(task.status, 'new');
		assert.equal(task.text, body);
		assert.equal(task.truncated, false);
		assert.equal(task.hash, computeNoteHashes(body).body);
		assert.ok(task.instructions.includes('PERSON') && task.instructions.includes('submit_extraction'));
		assert.ok(/Extract up to 15 /.test(task.instructions), 'standard mode: 15 per ~1500 chars');
		assert.deepEqual(task.existing_entities, ['Anthropic'], 'entities only from hidden notes stay hidden');
		assert.equal(task.existing_entity_count, 1);

		const submitted = await call('submit_extraction', {
			note: 'note.md',
			hash: task.hash,
			entities: [
				{ name: 'Anthropic', entity_type: 'ORGANIZATION' },
				{ name: 'Claude', entity_type: 'tool', description: 'A large language model.' },
				{ name: 'Writing', entity_type: 'HOBBY' },
			],
			relationships: [
				{ source: 'Anthropic', target: 'Claude', relationship: 'develops' },
				{ source: 'Claude', target: 'Nobody', relationship: 'helps' },
			],
		});
		assert.equal(submitted.isError, undefined, submitted.content[0].text);
		const result = submitted.value;
		assert.deepEqual(result.received, { entities: 3, relationships: 2 });
		assert.deepEqual(result.added, { entities: 1, merged_entities: 0, relationships: 1 });
		assert.deepEqual(result.dropped.map((d: any) => d.item), ['entities[2]', 'relationships[1]']);
		assert.ok(result.dropped[0].problem.startsWith('entity_type: "HOBBY"'), result.dropped[0].problem);
		assert.equal(result.dropped[1].problem, 'target: names no entity in this extraction');

		const claude = graphCache.getNodeByName('Claude');
		assert.ok(claude && claude.entityType === 'TOOL' && claude.sourceNotes.includes('note.md'));
		assert.ok(graphCache.getNodeById('organization:anthropic')!.sourceNotes.includes('note.md'), 'reuses the existing entity');
		assert.ok(graphCache.getAllEdges().some(e => e.source === 'organization:anthropic' && e.target === claude.id && e.sourceNote === 'note.md'));
		assert.equal(latest().hashes.hashes.find((h: any) => h.path === 'note.md').hash, task.hash);
		assert.equal(allBodies.length, 0, 'no provider call');

		const again = (await call('notes_to_analyze', {})).value;
		assert.ok(!again.notes.some((n: any) => n.path === 'note.md'));
		assert.equal((await call('get_extraction_task', { note: 'note.md' })).value.status, 'unchanged');

		// Resubmitting the same result changes nothing.
		const repeat = (await call('submit_extraction', {
			note: 'note.md', hash: task.hash,
			entities: [{ name: 'Claude', entity_type: 'TOOL' }, { name: 'Anthropic', entity_type: 'ORGANIZATION' }],
			relationships: [{ source: 'Anthropic', target: 'Claude', relationship: 'develops' }],
		})).value;
		assert.deepEqual(repeat.added, { entities: 0, merged_entities: 0, relationships: 0 });
		assert.ok(plugin.settings.mcpGraphWrites);
	}

	// A note edited after get_extraction_task is refused, and nothing is saved.
	{
		const { vault, graphCache, call, latest } = await fixture();
		vault.seed('note.md', body);
		const task = (await call('get_extraction_task', { note: 'note.md' })).value;
		vault.bodies.set('note.md', `${body}\n\nA new paragraph about Gemini.`);
		const refused = await call('submit_extraction', {
			note: 'note.md', hash: task.hash,
			entities: [{ name: 'Claude', entity_type: 'TOOL' }], relationships: [],
		});
		assert.equal(refused.isError, true);
		assert.ok(refused.value.error.includes('changed after get_extraction_task'));
		assert.equal(graphCache.getNodeByName('Claude'), undefined);
		assert.equal(latest()?.hashes, undefined);
	}

	// A submission where every entity breaks the rules saves nothing.
	{
		const { vault, graphCache, call, latest } = await fixture();
		vault.seed('note.md', body);
		const task = (await call('get_extraction_task', { note: 'note.md' })).value;
		const refused = await call('submit_extraction', {
			note: 'note.md', hash: task.hash,
			entities: [{ name: 'Claude', entity_type: 'NOTE' }, { entity_type: 'TOOL' }], relationships: [],
		});
		assert.equal(refused.isError, true);
		assert.ok(refused.value.error.startsWith('Nothing saved'), refused.value.error);
		assert.ok(refused.value.error.includes('entities[0]: entity_type: "NOTE" is not one of'), refused.value.error);
		assert.equal(graphCache.getAllNodes().length, 0);
		assert.equal(latest()?.hashes, undefined);

		const malformed = await call('submit_extraction', { note: 'note.md', hash: task.hash, entities: 'Claude', relationships: [] });
		assert.equal(malformed.isError, true);
		assert.ok(malformed.content[0].text.includes('"entities" must be a list'));
	}

	// Excluded, missing and too-short notes are refused without being read, and
	// an excluded note is indistinguishable from a missing one.
	{
		const { vault, call, reads } = await fixture({ excludedPatterns: ['skills/**'] });
		vault.seed('skills/config.md', body);
		vault.seed('short.md', 'short');
		const excluded = await call('get_extraction_task', { note: 'skills/config.md' });
		const missing = await call('get_extraction_task', { note: 'nowhere.md' });
		assert.equal(excluded.isError, true);
		assert.equal(excluded.value.error, missing.value.error.replace('nowhere.md', 'skills/config.md'));
		const excludedSubmit = await call('submit_extraction', {
			note: 'skills/config.md', hash: computeNoteHashes(body).body,
			entities: [{ name: 'Claude', entity_type: 'TOOL' }], relationships: [],
		});
		assert.equal(excludedSubmit.isError, true);
		assert.ok(!reads.includes('skills/config.md'));
		const short = await call('get_extraction_task', { note: 'short.md' });
		assert.ok(short.isError && short.value.error.includes('too short'));
	}

	// Through the JSON-RPC dispatcher, as a client sends it.
	{
		const { vault, registry, call } = await fixture();
		vault.seed('note.md', body);
		const task = (await call('get_extraction_task', { note: 'note.md' })).value;
		const dispatcher = new McpDispatcher({ name: 'sgb', version: '0' }, registry, () => '');
		const reply = await dispatcher.handle({
			jsonrpc: '2.0', id: 1, method: 'tools/call',
			params: { name: 'submit_extraction', arguments: {
				note: 'note.md', hash: task.hash,
				entities: [{ name: 'Claude', entity_type: 'TOOL' }], relationships: [],
			} },
		}, { 'mcp-protocol-version': '2025-06-18' });
		const result = (reply.body as any).result;
		assert.equal(reply.status, 200);
		assert.equal(result.isError, undefined);
		assert.equal(result.structuredContent.added.entities, 1);
	}

	console.log('ok   mcp extraction tools');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
