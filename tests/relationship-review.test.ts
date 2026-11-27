import assert from 'node:assert/strict';
import './graph-harness';
import { fakeSyncPlugin } from './vault-stub';
import { allBodies, resetBodies, setQueue, setScripted } from './obsidian-stub';
import {
	applyRelationshipCorrection, checkOneRelationship, flagRelationship, readRelationshipForReview,
	reviewNextRelationships, undoLastRelationshipCorrection,
} from '../src/analysis/relationship-review';
import { analyzeEntireVault, analyzeFile, applyExtraction, cancelVaultAnalysis } from '../src/commands/analyze';
import { runBackgroundRelationshipReview } from '../src/analysis/background-relationship-review';
import { loadHashes } from '../src/graph/hashes';
import { generateEdgeId, removeNoteFromCache } from '../src/graph/merge';
import { ObsidianVaultSource } from '../src/query/obsidian-source';
import { GraphSnapshot } from '../src/query/snapshot';
import type { OntologyExtractionResult } from '../src/types';

const rejected = 'Atlas evaluated Beacon and declined to adopt it. The team recorded its decision at the quarterly meeting.';
const adopted = 'Atlas uses Beacon for its production builds. Deployment finished in June after a successful trial.';
const oldEdge = generateEdgeId('tool:atlas', 'tool:beacon', 'uses');
const newEdge = generateEdgeId('tool:atlas', 'tool:beacon', 'evaluated');

const nodes: OntologyExtractionResult['nodes'] = [
	{ id: 'a', entityType: 'TOOL', properties: { name: 'Atlas' } },
	{ id: 'b', entityType: 'TOOL', properties: { name: 'Beacon' } },
];

function extraction(verb = 'uses', detail?: string): OntologyExtractionResult {
	return { nodes, relationships: [{ source: 'a', target: 'b', relationship: verb, properties: { detail } }] };
}

function response(value: unknown) {
	return { status: 200, body: { message: { role: 'assistant', content: JSON.stringify(value) }, done_reason: 'stop' } };
}

const emptyExtraction = response({ entities: [], relationships: [] });

function checkResponse(verdict = 'unclear', quote = '', verb = '', count = 1) {
	return response({ checks: Array.from({ length: count }, (_, id) => ({ id, verdict, quote, verb, reverse: false })) });
}

async function fixture(settings = {}, data?: Record<string, unknown>) {
	const ctx = fakeSyncPlugin({ apiProvider: 'ollama', enableEntityNotes: false, enableRelatedWriteback: false, ...settings }, data);
	Object.assign(ctx.plugin.app.vault, { configDir: '.obsidian' });
	await ctx.graphCache.ensureLoaded();
	ctx.plugin.updateStatusBar = () => undefined;
	resetBodies();
	return ctx;
}

async function correctionsSurviveAndUndo() {
	const { plugin, graphCache, vault, latest } = await fixture();
	const a = vault.seed('a.md', rejected);
	const b = vault.seed('b.md', adopted);
	await applyExtraction(plugin, a, rejected, extraction(), { replace: true });
	await applyExtraction(plugin, b, adopted, extraction(), { replace: true });
	assert.deepEqual(graphCache.getEdgeById(oldEdge)?.noteEvidence?.map(item => item.note), ['a.md', 'b.md']);
	assert.ok(flagRelationship(plugin, oldEdge, 'a.md'));
	setScripted(checkResponse('replace', 'Atlas evaluated Beacon', 'evaluated'));
	const [review] = await reviewNextRelationships(plugin);
	assert.equal(allBodies.length, 1);
	assert.equal(review.candidate.note, 'a.md');
	assert.deepEqual(review.verdict.span, [0, 'Atlas evaluated Beacon'.length]);
	await applyRelationshipCorrection(plugin, review.candidate, review.verdict);
	assert.equal(graphCache.getEdgeById(oldEdge)?.sourceNote, 'b.md');
	assert.equal(graphCache.getEdgeById(newEdge)?.sourceNote, 'a.md');
	assert.deepEqual(graphCache.getEdgeById(newEdge)?.noteEvidence?.[0].span, review.verdict.span);

	// A re-run of the same source respects the decision, even when the model
	// repeats the bad claim and omits the replacement.
	await applyExtraction(plugin, a, rejected, extraction(), { replace: true });
	assert.equal(graphCache.getEdgeById(oldEdge)?.noteEvidence?.length, 1);
	assert.ok(graphCache.getEdgeById(newEdge));

	const reloaded = await fixture({}, latest() as Record<string, unknown>);
	reloaded.vault.seed('a.md', rejected);
	assert.ok(await undoLastRelationshipCorrection(reloaded.plugin));
	assert.deepEqual(reloaded.graphCache.getEdgeById(oldEdge)?.noteEvidence?.map(item => item.note), ['b.md', 'a.md']);
	assert.equal(reloaded.graphCache.getEdgeById(newEdge), undefined);

	// A later edit can genuinely support the old verb. Only this note's prior
	// support and the correction for its old revision are superseded.
	vault.bodies.set(a.path, adopted);
	await applyExtraction(plugin, a, adopted, extraction(), { replace: true });
	assert.equal(graphCache.getEdgeById(newEdge), undefined);
	assert.equal(graphCache.getEdgeById(oldEdge)?.noteEvidence?.length, 2);
	assert.equal(graphCache.getRelationshipCorrections(a.path).length, 0);
}

async function refreshIsSourceScoped() {
	const { plugin, graphCache, vault } = await fixture({ excludedPatterns: ['a.md'] });
	const a = vault.seed('a.md', adopted);
	const b = vault.seed('b.md', adopted);
	const exclusion = plugin.settings.excludedPatterns;
	plugin.settings.excludedPatterns = [];
	await applyExtraction(plugin, a, adopted, extraction('uses', 'Private detail'), { replace: true });
	await applyExtraction(plugin, b, adopted, extraction('uses', 'Public detail'), { replace: true });
	plugin.settings.excludedPatterns = exclusion;
	const source = new ObsidianVaultSource(plugin);
	const snapshot = new GraphSnapshot(graphCache, source);
	const edges = snapshot.adj[snapshot.entityIdx.get('tool:atlas')!];
	assert.ok(edges.some(edge => edge.verb === 'uses' && edge.evidence === 'b.md' && edge.detail === 'Public detail'));

	// A conflicting source edit does not discard the second source. Import
	// support also survives when the last ordinary source is later removed.
	graphCache.editEdge(graphCache.getEdgeById(oldEdge)!, edge => {
		edge.properties.medLit = { project: { relIds: [1], evidence: [{ note: 'article.md', quote: 'Imported evidence' }] } };
	});
	vault.bodies.set(a.path, rejected);
	await applyExtraction(plugin, a, rejected, extraction('evaluated'), { replace: true });
	assert.equal(graphCache.getEdgeById(oldEdge)?.sourceNote, 'b.md');
	await vault.rename(b, 'moved/b.md');
	graphCache.renameSourceNote('b.md', b.path);
	assert.equal(graphCache.getEdgesBySourceNote('b.md').length, 0);
	assert.ok(graphCache.getEdgesBySourceNote(b.path).some(edge => edge.id === oldEdge));
	removeNoteFromCache(graphCache, b.path);
	assert.equal(graphCache.getEdgeById(oldEdge)?.sourceNote, 'article.md');
	assert.equal(graphCache.getEdgeById(newEdge)?.sourceNote, 'a.md');
}

async function incompleteAndStaleExtracts() {
	const { plugin, graphCache, vault } = await fixture();
	const a = vault.seed('a.md', adopted);
	await applyExtraction(plugin, a, adopted, extraction(), { replace: true });
	const hashes = await loadHashes(plugin);
	const before = hashes.hashes[0].hash;
	vault.bodies.set(a.path, `${rejected} ${'First section. '.repeat(93)}\n\n${'Later section. '.repeat(40)}`);
	setQueue([emptyExtraction, { status: 500, body: { error: 'failed second chunk' } }]);
	assert.equal((await analyzeFile(plugin, a, hashes)).success, false);
	assert.equal((await loadHashes(plugin)).hashes[0].hash, before);
	assert.ok(graphCache.getEdgeById(oldEdge));

	vault.bodies.set(a.path, rejected);
	setScripted(() => {
		vault.bodies.set(a.path, `${rejected}\nAnother edit arrived during extraction.`);
		return emptyExtraction;
	});
	assert.equal((await analyzeFile(plugin, a, hashes)).success, false);
	assert.ok(graphCache.getEdgeById(oldEdge));
	assert.equal((await loadHashes(plugin)).hashes[0].hash, before);

	setScripted(emptyExtraction);
	assert.equal((await analyzeFile(plugin, a, hashes)).success, true);
	assert.equal(graphCache.getEdgeById(oldEdge), undefined);
}

async function reviewLimitsAndStaleness() {
	const { plugin, graphCache, vault } = await fixture();
	for (let i = 0; i < 15; i++) {
		const a = vault.seed(`note-${i}.md`, `${rejected} Entry ${i}.`);
		await applyExtraction(plugin, a, vault.body(a.path), extraction(`claim ${i}`), { replace: true });
	}
	plugin.settings.excludedPatterns = ['note-0.md'];
	const reads: string[] = [];
	plugin.app.vault.read = async file => {
		reads.push(file.path);
		return vault.bodies.get(file.path) ?? '';
	};
	resetBodies();
	setScripted(checkResponse('retract', 'made-up quote', '', 6));
	const first = await reviewNextRelationships(plugin);
	assert.equal(first.length, 6);
	assert.ok(first.every(item => item.verdict.kind === 'unclear'));
	assert.equal(allBodies.length, 1);
	assert.ok(reads.length <= 12);
	assert.ok(!reads.includes('note-0.md'));
	const request = allBodies[0] as { messages: { content: string }[]; options: { num_predict: number } };
	assert.ok(request.messages[0].content.length <= 6000);
	assert.ok(!request.messages[0].content.includes('Entry 0.'));
	assert.equal(request.options.num_predict, 768);
	const second = await reviewNextRelationships(plugin);
	assert.equal(second.length, 6);
	assert.ok(!second.some(item => first.some(old => old.candidate.edgeId === item.candidate.edgeId)));

	const edgeId = generateEdgeId('tool:atlas', 'tool:beacon', 'claim 14');
	setScripted(checkResponse('retract', 'declined to adopt it'));
	const [proposal] = await checkOneRelationship(plugin, edgeId, 'note-14.md');
	assert.equal(proposal.verdict.kind, 'retract');
	vault.bodies.set('note-14.md', adopted);
	await assert.rejects(applyRelationshipCorrection(plugin, proposal.candidate, proposal.verdict), /changed/);
	assert.ok(graphCache.getEdgeById(edgeId));
	const current = await readRelationshipForReview(plugin, edgeId, 'note-14.md');
	assert.ok(current);
	await applyRelationshipCorrection(plugin, current, { kind: 'retract' });
	assert.equal(graphCache.getEdgeById(edgeId), undefined);
}

async function vaultReviewIsOptIn() {
	for (const mode of ['off', 'on', 'cancel', 'automatic']) {
		const { plugin, graphCache, vault } = await fixture({
			reviewAfterVaultAnalysis: mode !== 'off', autoCorrectRelationships: mode === 'automatic',
		});
		const old = vault.seed('old.md', adopted);
		await applyExtraction(plugin, old, adopted, extraction(), { replace: true });
		graphCache.editEdge(graphCache.getEdgeById(oldEdge)!, edge => { edge.createdAt = 1; });
		vault.seed('new.md', rejected);
		let shown = 0;
		setQueue([emptyExtraction, () => {
			if (mode === 'cancel') cancelVaultAnalysis();
			return checkResponse('supported', 'Atlas uses Beacon');
		}]);
		const totals = await analyzeEntireVault(plugin, undefined, undefined, reviews => { shown = reviews.length; });
		assert.equal(totals.analyzed, 1);
		assert.equal(allBodies.length, mode === 'off' || mode === 'automatic' ? 1 : 2);
		assert.equal(shown, mode === 'on' ? 1 : 0);
		assert.equal(graphCache.getEdgeById(oldEdge)?.noteEvidence?.[0].checked, mode === 'on' ? true : undefined);
	}
}

async function backgroundAppliesAndPersistsItsBudget() {
	const { plugin, graphCache, vault, latest } = await fixture();
	const a = vault.seed('a.md', rejected);
	const b = vault.seed('b.md', adopted);
	await applyExtraction(plugin, a, rejected, extraction(), { replace: true });
	await applyExtraction(plugin, b, adopted, extraction(), { replace: true });
	setScripted(checkResponse('replace', 'Atlas evaluated Beacon', 'evaluated'));
	assert.equal(await runBackgroundRelationshipReview(plugin), 0);
	assert.equal(allBodies.length, 0);

	plugin.settings.autoCorrectRelationships = true;
	assert.equal(await runBackgroundRelationshipReview(plugin), 1);
	assert.equal(allBodies.length, 1);
	assert.equal(graphCache.getEdgeById(newEdge)?.sourceNote, a.path);
	assert.deepEqual(graphCache.getEdgeById(oldEdge)?.noteEvidence?.map(source => source.note), [b.path]);
	assert.equal(vault.body(a.path), rejected);
	assert.ok(graphCache.getRelationshipReview().lastBackgroundRequestAt);
	assert.equal(await runBackgroundRelationshipReview(plugin), 0);
	assert.equal(allBodies.length, 1);

	const reloaded = await fixture({ autoCorrectRelationships: true }, latest() as Record<string, unknown>);
	reloaded.vault.seed(a.path, rejected);
	reloaded.vault.seed(b.path, adopted);
	assert.equal(await runBackgroundRelationshipReview(reloaded.plugin), 0);
	assert.equal(allBodies.length, 0);
	assert.ok(await undoLastRelationshipCorrection(reloaded.plugin));
	assert.equal(reloaded.graphCache.getEdgeById(newEdge), undefined);
	assert.ok(reloaded.graphCache.getEdgeById(oldEdge)?.noteEvidence?.find(source => source.note === a.path)?.checked);
}

async function backgroundSkipsUnverifiedAndStaleChanges() {
	for (const mode of ['missing-entity', 'stale', 'disabled-during-request', 'failed-request']) {
		const { plugin, graphCache, vault, latest } = await fixture({ autoCorrectRelationships: true });
		const file = vault.seed('a.md', rejected);
		await applyExtraction(plugin, file, rejected, extraction(), { replace: true });
		setScripted(() => {
			if (mode === 'stale') vault.bodies.set(file.path, adopted);
			if (mode === 'disabled-during-request') plugin.settings.autoCorrectRelationships = false;
			if (mode === 'failed-request') return { status: 500, body: { error: 'failed review' } };
			return checkResponse('replace', mode === 'missing-entity' ? 'declined to adopt' : 'Atlas evaluated Beacon', 'evaluated');
		});
		if (mode === 'failed-request') await assert.rejects(runBackgroundRelationshipReview(plugin));
		else assert.equal(await runBackgroundRelationshipReview(plugin), 0);
		assert.equal(allBodies.length, 1, mode);
		assert.equal(graphCache.getEdgeById(newEdge), undefined, mode);
		assert.ok(graphCache.getEdgeById(oldEdge), mode);
		assert.equal(graphCache.getRelationshipCorrections(file.path).length, 0, mode);
		const reloaded = await fixture({ autoCorrectRelationships: true }, latest() as Record<string, unknown>);
		assert.ok(reloaded.graphCache.getRelationshipReview().lastBackgroundRequestAt, mode);
	}
}

async function reviewMakesOneAttempt() {
	const { plugin, vault } = await fixture({ apiProvider: 'deepseek', apiKeys: { deepseek: 'test-key' } });
	const file = vault.seed('a.md', adopted);
	await applyExtraction(plugin, file, adopted, extraction(), { replace: true });
	setQueue([
		{ status: 200, body: { choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'stop' }] } },
		{ status: 200, body: { choices: [{ message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }] } },
	]);
	await assert.rejects(checkOneRelationship(plugin, oldEdge, file.path), /Empty response/);
	assert.equal(allBodies.length, 1);
	const wire = allBodies[0] as { max_tokens: number; thinking: { type: string } };
	assert.equal(wire.max_tokens, 768);
	assert.equal(wire.thinking.type, 'disabled');
}

async function main() {
	await correctionsSurviveAndUndo();
	await refreshIsSourceScoped();
	await incompleteAndStaleExtracts();
	await reviewLimitsAndStaleness();
	await vaultReviewIsOptIn();
	await reviewMakesOneAttempt();
	await backgroundAppliesAndPersistsItsBudget();
	await backgroundSkipsUnverifiedAndStaleChanges();
	console.log('relationship-review: source refresh, bounded review, automatic correction and undo passed');
}

void main().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
