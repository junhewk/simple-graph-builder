import assert from 'node:assert/strict';
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';
import { allBodies, resetBodies, setScripted, notices } from './obsidian-stub';
import { analyzeFile, analyzeCurrentNote, analyzeEntireVault, autoAnalyzeFile, isAnalyzingVault, cancelVaultAnalysis } from '../src/commands/analyze';
import { computeNoteHashes } from '../src/graph/hashes';
import { HashData } from '../src/types';

// Batch analysis yields between successful notes. Keep real, short timers so
// the suite cannot exit successfully with a pending promise.
window.setTimeout = ((callback: () => void) => setTimeout(callback, 0)) as typeof window.setTimeout;
window.clearTimeout = (id => clearTimeout(id)) as typeof window.clearTimeout;

const body = '# Research\n\nMachine learning identifies patterns through computational methods and experiments.';
const response = {
	status: 200,
	body: { message: { role: 'assistant', content: JSON.stringify({
		entities: [{ name: 'Machine learning', entity_type: 'CONCEPT', description: 'Computational learning.' }],
		relationships: [],
	}) }, done_reason: 'stop' },
};

async function fixture(settings = {}) {
	const ctx = fakeSyncPlugin({ apiProvider: 'ollama', autoAnalyzeOnSave: true, ...settings });
	await ctx.graphCache.ensureLoaded();
	const reads: string[] = [];
	ctx.plugin.app.vault.read = async file => { reads.push(file.path); return ctx.vault.bodies.get(file.path) ?? ''; };
	ctx.plugin.updateStatusBar = () => undefined;
	resetBodies();
	notices.length = 0;
	setScripted(response);
	return { ...ctx, reads };
}

async function main() {
	// No route may read, bill, mutate, or write back an excluded note, even when
	// its previously extracted entities and hashes still exist.
	for (const mode of ['manual', 'file', 'auto', 'vault']) {
		const ctx = await fixture({ excludedPatterns: ['skills/**'] });
		const { plugin, vault, graphCache, reads } = ctx;
		const file = vault.seed('skills/config.md', body);
		graphCache.addNode({ id: 'concept:prior', entityType: 'CONCEPT', properties: { name: 'Prior' }, sourceNotes: [file.path] });
		await graphCache.flush();
		const hashes: HashData = { hashes: [{ path: file.path, hash: 'old-hash', analyzedAt: 1 }] };
		await plugin.saveData({ ...ctx.latest(), hashes });
		const before = JSON.stringify(ctx.latest());
		const writes = JSON.stringify(vault.stats);
		plugin.app.workspace = { getActiveViewOfType: () => ({ file }) } as never;
		if (mode === 'manual') await analyzeCurrentNote(plugin);
		if (mode === 'file') {
			const result = await analyzeFile(plugin, file, hashes, { skipUnchanged: false });
			assert.equal(result.excluded, true);
			assert.equal(result.skipped, false);
		}
		if (mode === 'auto') await autoAnalyzeFile(plugin, file);
		if (mode === 'vault') {
			let progressed = false;
			const result = await analyzeEntireVault(plugin, () => { progressed = true; });
			assert.equal(result.excluded, 1);
			assert.equal(result.analyzed + result.skipped + result.errors, 0);
			assert.equal(progressed, false);
		}
		assert.deepEqual(reads, [], mode);
		assert.equal(allBodies.length, 0, mode);
		assert.equal(JSON.stringify(ctx.latest()), before, mode);
		assert.equal(JSON.stringify(vault.stats), writes, mode);
		assert.equal(graphCache.getNodesBySourceNote(file.path).length, 1, mode);
		assert.equal(hashes.hashes[0].hash, 'old-hash', mode);
		if (mode === 'manual') assert.ok(notices.some(n => n.includes('excluded')));
		if (mode === 'auto') assert.deepEqual(notices, []);
	}

	// Mixed vault: progress excludes both custom matches and generated notes;
	// unchanged and too-short notes remain ordinary skips.
	{
		const { plugin, vault, reads } = await fixture({ excludedPatterns: ['skills/**'] });
		vault.seed('skills/config.md', body);
		vault.seed('Entities/generated.md', body);
		vault.seed('short.md', 'short');
		vault.seed('unchanged.md', body);
		vault.seed('new.md', body);
		await plugin.saveData({ hashes: { hashes: [{ path: 'unchanged.md', hash: computeNoteHashes(body).body, analyzedAt: 1 }] } });
		const progress: [number, number, string][] = [];
		const result = await analyzeEntireVault(plugin, (current, total, file) => progress.push([current, total, file]));
		assert.equal(result.excluded, 2);
		assert.equal(result.skipped, 2);
		assert.equal(result.analyzed, 1);
		assert.equal(result.errors, 0);
		assert.equal(allBodies.length, 1);
		assert.deepEqual(reads, ['short.md', 'unchanged.md', 'new.md']);
		assert.deepEqual(progress, [[1, 3, 'short'], [2, 3, 'unchanged'], [3, 3, 'new']]);
		assert.ok(notices.some(n => n.includes('Excluded: 2')));
	}

	// Settings and renamed paths are evaluated when a queued note starts.
	{
		const { plugin, vault, reads } = await fixture();
		vault.seed('first.md', body);
		vault.seed('second.md', body);
		const result = await analyzeEntireVault(plugin, current => {
			if (current === 2) plugin.settings.excludedPatterns = ['second.md'];
		});
		assert.equal(result.analyzed, 1);
		assert.equal(result.excluded, 1);
		assert.deepEqual(reads, ['first.md']);
	}

	// A rule changed during a read does not interrupt that note; it applies next time.
	{
		const { plugin, vault } = await fixture({ enableEntityNotes: false });
		const file = vault.seed('inflight.md', body);
		plugin.app.vault.read = async () => { plugin.settings.excludedPatterns = ['inflight.md']; return body; };
		const hashes = { hashes: [] };
		assert.equal((await analyzeFile(plugin, file, hashes)).success, true);
		assert.equal((await analyzeFile(plugin, file, hashes)).excluded, true);
		assert.equal(allBodies.length, 1);
	}

	for (const mode of ['manual', 'file', 'auto', 'vault']) {
		const { plugin, vault, reads } = await fixture({ respectObsidianExcludedFiles: true });
		const file = vault.seed('note.md', body);
		plugin.app.workspace = { getActiveViewOfType: () => ({ file }) } as never;
		if (mode === 'manual') await analyzeCurrentNote(plugin);
		if (mode === 'file') assert.equal((await analyzeFile(plugin, file, { hashes: [] })).unavailable, true);
		if (mode === 'vault') {
			assert.equal((await analyzeEntireVault(plugin)).errors, 1);
			assert.equal(isAnalyzingVault(), false);
		}
		if (mode === 'auto') {
			await autoAnalyzeFile(plugin, file);
			await autoAnalyzeFile(plugin, file);
			assert.equal(notices.length, 1, 'one compatibility notice, not one per save');
		}
		assert.deepEqual(reads, [], mode);
		assert.equal(allBodies.length, 0, mode);
	}

	// A native matcher that breaks after preflight stops the batch, while
	// preserving successful work and resetting the running flag.
	{
		const { plugin, vault, reads } = await fixture({ respectObsidianExcludedFiles: true, enableEntityNotes: false });
		vault.seed('first.md', body);
		vault.seed('second.md', body);
		const cache = plugin.app.metadataCache as unknown as { isUserIgnored: () => boolean };
		cache.isUserIgnored = () => false;
		const result = await analyzeEntireVault(plugin, current => {
			if (current === 2) cache.isUserIgnored = () => { throw new Error('API changed'); };
		});
		assert.equal(result.analyzed, 1);
		assert.equal(result.errors, 1);
		assert.deepEqual(reads, ['first.md']);
		assert.equal(isAnalyzingVault(), false);
		assert.ok(notices.some(n => n.includes('analysis stopped')));
	}

	// Cancellation still preserves completed work and permits another batch.
	{
		const { plugin, vault, reads } = await fixture({ enableEntityNotes: false });
		vault.seed('first.md', body);
		vault.seed('second.md', body);
		const result = await analyzeEntireVault(plugin, () => cancelVaultAnalysis());
		assert.equal(result.analyzed, 1);
		assert.deepEqual(reads, ['first.md']);
		assert.equal(isAnalyzingVault(), false);
	}
	console.log('analysis-exclusions: all checks passed');
}

main().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
