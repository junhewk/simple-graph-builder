import { TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import type { OntologyEdge, OntologyNode, RelationshipClaim, RelationshipCorrection } from '../types';
import { isNoteNode } from '../types';
import { getExtractionConfigError } from '../extraction/providers/models';
import { settingsToExtractionOptions } from '../extraction/llm-client';
import { checkRelationshipExcerpts, normalizeReviewVerb, RELATIONSHIP_REVIEW_LIMIT } from '../extraction/relationship-review';
import type { RelationshipExcerpt, ReviewVerdict } from '../extraction/relationship-review';
import { computeHash } from '../graph/hashes';
import {
	noteRelationshipEvidence, relationshipId, removeRelationshipEvidence, setNoteRelationshipEvidence, upsertRelationshipEvidence,
} from '../graph/relationship-evidence';
import { stripFrontmatter } from '../sync/note-content';
import { upsertEntityNotes } from '../sync';
import { getAnalysisEligibility } from './exclusions';

const MAX_FLAGS = 32;
const MAX_SCANNED_EDGES = 128;
const MAX_SOURCE_READS = 12;
const MAX_SOURCE_BYTES = 256_000;
const EXCERPT_CHARS = 520;
const running = new WeakSet<SimpleGraphBuilderPlugin>();

export interface ReviewCandidate extends RelationshipExcerpt {
	edgeId: string;
	claim: RelationshipClaim;
	note: string;
	file: TFile;
	bodyHash: string;
	extractedHash?: string;
	mtime?: number;
}

export interface RelationshipReview {
	candidate: ReviewCandidate;
	verdict: ReviewVerdict;
	applied?: true;
}

export function isRelationshipReviewRunning(plugin: SimpleGraphBuilderPlugin): boolean {
	return running.has(plugin);
}

function eligibleFile(plugin: SimpleGraphBuilderPlugin, path: string): TFile | undefined {
	const vault = plugin.app.vault;
	const file = vault.getAbstractFileByPath(path) ?? vault.getAbstractFileByPath(path.normalize('NFD'));
	if (!(file instanceof TFile) || file.extension !== 'md' || file.stat?.size > MAX_SOURCE_BYTES) return;
	if (getAnalysisEligibility(plugin, file).status === 'allowed') return file;
}

export function relationshipReviewSources(plugin: SimpleGraphBuilderPlugin, id: string): string[] {
	const edge = plugin.graphCache.getEdgeById(id);
	const subject = edge && plugin.graphCache.getNodeById(edge.source);
	const object = edge && plugin.graphCache.getNodeById(edge.target);
	if (!edge || !subject || !object || isNoteNode(subject) || isNoteNode(object)) return [];
	return noteRelationshipEvidence(edge).filter(item => !item.correctionId && eligibleFile(plugin, item.note)).map(item => item.note);
}

export function flagRelationship(plugin: SimpleGraphBuilderPlugin, id: string, note: string): boolean {
	const cache = plugin.graphCache;
	const review = cache.getRelationshipReview();
	const flags = review.flags ?? [];
	if (flags.some(flag => flag.edgeId === id && flag.note === note)) return true;
	const active = flags.filter(flag => cache.getEdgeById(flag.edgeId));
	if (active.length >= MAX_FLAGS || !relationshipReviewSources(plugin, id).includes(note)) return false;
	cache.setRelationshipReview({ ...review, flags: [...active, { edgeId: id, note }] });
	return true;
}

interface SourceText {
	file: TFile;
	body: string;
	bodyHash: string;
	mtime?: number;
}

async function readSource(plugin: SimpleGraphBuilderPlugin, note: string): Promise<SourceText | undefined> {
	const file = eligibleFile(plugin, note);
	if (!file) return;
	const mtime = file.stat?.mtime;
	const body = stripFrontmatter(await plugin.app.vault.read(file)).body;
	if (file !== eligibleFile(plugin, note) || mtime !== file.stat?.mtime || body.length > MAX_SOURCE_BYTES) return;
	return { file, body, bodyHash: computeHash(body), mtime };
}

function firstMentions(body: string, node: OntologyNode): RegExpMatchArray[] {
	const names = [node.properties.name, ...(node.properties.aliases ?? []).slice(0, 2)]
		.map(name => name.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).filter(Boolean);
	if (!names.length) return [];
	const matches: RegExpMatchArray[] = [];
	for (const match of body.matchAll(new RegExp(names.join('|'), 'giu'))) {
		matches.push(match);
		if (matches.length === 24) break;
	}
	return matches;
}

function excerptAround(body: string, subject: OntologyNode, object: OntologyNode): { text: string; offset: number } {
	if (body.length <= EXCERPT_CHARS) return { text: body, offset: 0 };
	const left = firstMentions(body, subject);
	const right = firstMentions(body, object);
	let center = left[0]?.index ?? right[0]?.index ?? Math.floor(EXCERPT_CHARS / 2);
	let distance = Infinity;
	for (const a of left) {
		for (const b of right) {
			const from = Math.min(a.index ?? 0, b.index ?? 0);
			const to = Math.max((a.index ?? 0) + a[0].length, (b.index ?? 0) + b[0].length);
			if (to - from >= distance) continue;
			distance = to - from;
			if (distance < EXCERPT_CHARS) center = (from + to) / 2;
		}
	}
	const offset = Math.max(0, Math.min(body.length - EXCERPT_CHARS, Math.floor(center - EXCERPT_CHARS / 2)));
	return { text: body.slice(offset, offset + EXCERPT_CHARS), offset };
}

function makeCandidate(plugin: SimpleGraphBuilderPlugin, edge: OntologyEdge, note: string, source: SourceText): ReviewCandidate | undefined {
	const { body, file, bodyHash, mtime } = source;
	const subject = plugin.graphCache.getNodeById(edge.source);
	const object = plugin.graphCache.getNodeById(edge.target);
	const evidence = noteRelationshipEvidence(edge).find(item => item.note === note && !item.correctionId);
	if (!subject || !object || isNoteNode(subject) || isNoteNode(object) || !evidence) return;
	return {
		...excerptAround(body, subject, object), edgeId: edge.id, note, file, bodyHash, mtime, extractedHash: evidence.bodyHash,
		subject: subject.properties.name, object: object.properties.name, verb: edge.relationship,
		claim: { source: edge.source, target: edge.target, relationship: edge.relationship },
	};
}

export async function readRelationshipForReview(plugin: SimpleGraphBuilderPlugin, id: string, note: string): Promise<ReviewCandidate | undefined> {
	if (!relationshipReviewSources(plugin, id).includes(note)) return;
	const source = await readSource(plugin, note);
	const edge = plugin.graphCache.getEdgeById(id);
	if (source && edge) return makeCandidate(plugin, edge, note, source);
}

function currentEdge(plugin: SimpleGraphBuilderPlugin, candidate: ReviewCandidate): OntologyEdge | undefined {
	const edge = plugin.graphCache.getEdgeById(candidate.edgeId);
	if (edge && relationshipId(edge) === relationshipId(candidate.claim) && noteRelationshipEvidence(edge).some(
		item => !item.correctionId && item.note === candidate.note && item.bodyHash === candidate.extractedHash,
	)) return edge;
}

async function runReview(
	plugin: SimpleGraphBuilderPlugin, prepare: () => Promise<ReviewCandidate[]>, cancelled: () => boolean = () => false,
	beforeRequest?: () => Promise<void>,
): Promise<RelationshipReview[]> {
	if (running.has(plugin)) throw new Error('A relationship review is already running.');
	const configError = getExtractionConfigError(plugin.settings);
	if (configError) throw new Error(configError);
	running.add(plugin);
	try {
		const isCurrent = (candidate: ReviewCandidate) => candidate.file === eligibleFile(plugin, candidate.note) &&
			candidate.mtime === candidate.file.stat?.mtime && currentEdge(plugin, candidate);
		const candidates = (await prepare()).filter(isCurrent);
		if (!candidates.length || cancelled()) return [];
		if (beforeRequest) await beforeRequest();
		const ready = beforeRequest ? candidates.filter(isCurrent) : candidates;
		if (!ready.length || cancelled()) return [];
		const results = await checkRelationshipExcerpts(settingsToExtractionOptions(plugin.settings), ready);
		if (cancelled()) return [];
		return [...results].map(([index, verdict]) => ({ candidate: ready[index], verdict }));
	} finally {
		running.delete(plugin);
	}
}

export function checkOneRelationship(plugin: SimpleGraphBuilderPlugin, edgeId: string, note: string): Promise<RelationshipReview[]> {
	return runReview(plugin, async () => {
		const candidate = await readRelationshipForReview(plugin, edgeId, note);
		return candidate ? [candidate] : [];
	});
}

export async function reviewNextRelationships(
	plugin: SimpleGraphBuilderPlugin,
	options: {
		touched?: ReadonlySet<string>; before?: number; cancelled?: () => boolean;
		autoApply?: boolean; beforeRequest?: () => Promise<void>;
	} = {},
): Promise<RelationshipReview[]> {
	const cache = plugin.graphCache;
	const state = cache.getRelationshipReview();
	let cursor = state.cursor ?? 0;
	const flags = state.flags ?? [];
	const results = await runReview(plugin, async () => {
		const candidates: ReviewCandidate[] = [];
		const sources = new Map<string, SourceText | undefined>();
		const seen = new Set<string>();
		const tryEdge = async (edge: OntologyEdge, flaggedNote?: string): Promise<void> => {
			const subject = cache.getNodeById(edge.source);
			if (seen.has(edge.id) || !subject || isNoteNode(subject) || (edge.createdAt ?? 0) >= (options.before ?? Infinity)) return;
			seen.add(edge.id);
			for (const evidence of noteRelationshipEvidence(edge)) {
				if (evidence.correctionId || (flaggedNote ? evidence.note !== flaggedNote : evidence.checked) || options.cancelled?.()) continue;
				if (!sources.has(evidence.note)) {
					if (sources.size >= MAX_SOURCE_READS) continue;
					const source = await readSource(plugin, evidence.note).catch(() => undefined);
					sources.set(evidence.note, source);
				}
				const source = sources.get(evidence.note);
				if (!source || !source.body.trim() || (evidence.bodyHash && evidence.bodyHash !== source.bodyHash)) continue;
				const candidate = makeCandidate(plugin, edge, evidence.note, source);
				if (candidate) {
					candidates.push(candidate);
					return;
				}
			}
		};

		for (const flag of flags) {
			if (candidates.length >= RELATIONSHIP_REVIEW_LIMIT - 1) break;
			const edge = cache.getEdgeById(flag.edgeId);
			if (edge) await tryEdge(edge, flag.note);
		}

		let scanned = 0;
		const walk = async (limit: number): Promise<void> => {
			let wrapped = false;
			while (scanned < MAX_SCANNED_EDGES && candidates.length < limit && !options.cancelled?.()) {
				const edge = cache.getEdgeAt(cursor);
				if (!edge) {
					cursor = 0;
					if (wrapped || !cache.getEdgeAt(0)) break;
					wrapped = true;
					continue;
				}
				cursor++;
				scanned++;
				await tryEdge(edge);
			}
		};
		await walk(candidates.length + 1);
		let neighbors = 0;
		for (const node of options.touched ?? []) {
			for (const edges of [cache.getEdgesBySource(node), cache.getEdgesByTarget(node)]) {
				for (const edge of edges) {
					if (candidates.length >= RELATIONSHIP_REVIEW_LIMIT || neighbors++ >= MAX_SCANNED_EDGES) break;
					await tryEdge(edge);
				}
			}
		}
		await walk(RELATIONSHIP_REVIEW_LIMIT);
		return candidates;
	}, options.cancelled, options.beforeRequest);

	if (options.cancelled?.()) return [];
	const sources = new Map<string, SourceText | undefined>();
	if (options.autoApply) {
		for (const { candidate, verdict } of results) {
			if (options.cancelled?.()) return [];
			if (qualifiesForAutomaticCorrection(plugin, candidate, verdict) && !sources.has(candidate.note)) {
				sources.set(candidate.note, await readSource(plugin, candidate.note).catch(() => undefined));
			}
		}
	}
	if (options.cancelled?.()) return [];

	const corrections: RelationshipCorrection[] = [];
	const checked = new Set<string>();
	const fresh = results.filter(review => {
		const { candidate, verdict } = review;
		const edge = currentEdge(plugin, candidate);
		if (!edge || candidate.file !== eligibleFile(plugin, candidate.note) || candidate.mtime !== candidate.file.stat?.mtime) return false;
		if (options.autoApply && qualifiesForAutomaticCorrection(plugin, candidate, verdict)) {
			const source = sources.get(candidate.note);
			if (!source || source.file !== candidate.file || source.bodyHash !== candidate.bodyHash ||
				source.mtime !== source.file.stat?.mtime || !verdict.span || source.body.slice(...verdict.span) !== verdict.quote) return false;
			const replacement = proposedReplacement(edge, verdict);
			const conflicts = replacement && cache.getRelationshipCorrections(candidate.note).some(correction =>
				correction.evidence.bodyHash === candidate.bodyHash && relationshipId(correction.original) === relationshipId(replacement));
			if (!conflicts && (replacement || verdict.kind === 'retract')) {
				corrections.push(stageRelationshipCorrection(plugin, candidate, verdict, source));
				review.applied = true;
				checked.add(`${edge.id}\u0000${candidate.note}`);
				return true;
			}
		}
		cache.editEdge(edge, live => setNoteRelationshipEvidence(live, noteRelationshipEvidence(live).map(item =>
			item.note === candidate.note && !item.correctionId ? {
				...item, bodyHash: candidate.bodyHash, checked: true,
				span: verdict.kind === 'supported' ? verdict.span : item.span,
			} : item,
		)));
		candidate.extractedHash = candidate.bodyHash;
		checked.add(`${edge.id}\u0000${candidate.note}`);
		return true;
	});
	const live = cache.getRelationshipReview();
	const remaining = live.flags?.filter(flag => !checked.has(`${flag.edgeId}\u0000${flag.note}`) && cache.getEdgeById(flag.edgeId));
	if (cursor !== (live.cursor ?? 0) || remaining?.length !== live.flags?.length) {
		cache.setRelationshipReview({ ...live, cursor, flags: remaining });
	}
	if (fresh.length || cursor !== (live.cursor ?? 0) || remaining?.length !== live.flags?.length) await cache.flush();
	if (corrections.length) await syncCorrections(plugin, corrections);
	return fresh;
}

function qualifiesForAutomaticCorrection(plugin: SimpleGraphBuilderPlugin, candidate: ReviewCandidate, verdict: ReviewVerdict): boolean {
	const quote = verdict.quote;
	if ((verdict.kind !== 'retract' && verdict.kind !== 'replace') || !verdict.span || !quote) return false;
	const subject = plugin.graphCache.getNodeById(candidate.claim.source);
	const object = plugin.graphCache.getNodeById(candidate.claim.target);
	if (!subject || !object || subject.id === object.id) return false;
	const targets = firstMentions(quote, object);
	return firstMentions(quote, subject).some(a => targets.some(b => {
		const startA = a.index ?? 0;
		const startB = b.index ?? 0;
		return startA + a[0].length <= startB || startB + b[0].length <= startA;
	}));
}

function proposedReplacement(edge: RelationshipClaim, verdict: ReviewVerdict): RelationshipClaim | undefined {
	if (verdict.kind !== 'replace') return;
	const verb = normalizeReviewVerb(verdict.verb ?? '');
	if (!verb) return;
	const replacement = {
		source: verdict.reverse ? edge.target : edge.source,
		target: verdict.reverse ? edge.source : edge.target,
		relationship: verb,
	};
	if (relationshipId(replacement) !== relationshipId(edge)) return replacement;
}

export async function applyRelationshipCorrection(
	plugin: SimpleGraphBuilderPlugin, candidate: ReviewCandidate, verdict: ReviewVerdict,
): Promise<void> {
	if (verdict.kind !== 'retract' && verdict.kind !== 'replace') throw new Error('Choose a correction first.');
	const source = await readSource(plugin, candidate.note);
	const correction = stageRelationshipCorrection(plugin, candidate, verdict, source);
	await plugin.graphCache.flush();
	await syncCorrections(plugin, [correction]);
}

function stageRelationshipCorrection(
	plugin: SimpleGraphBuilderPlugin, candidate: ReviewCandidate, verdict: ReviewVerdict, source: SourceText | undefined,
): RelationshipCorrection {
	const cache = plugin.graphCache;
	const edge = currentEdge(plugin, candidate);
	const evidence = edge && noteRelationshipEvidence(edge).find(item => item.note === candidate.note && !item.correctionId);
	if (!source || source.file !== candidate.file || source.bodyHash !== candidate.bodyHash || !edge || !evidence) {
		throw new Error('The note or relationship changed. Open the review again.');
	}
	if (verdict.span && source.body.slice(...verdict.span) !== verdict.quote) {
		throw new Error('The cited excerpt changed. Open the review again.');
	}

	const replacement = proposedReplacement(edge, verdict);
	if (verdict.kind === 'replace' && !replacement) throw new Error('Enter a different verb of up to 64 characters or reverse the direction.');
	const correction: RelationshipCorrection = {
		id: `${edge.id}\u0000${source.bodyHash}`, original: candidate.claim, evidence: { ...evidence, bodyHash: source.bodyHash, checked: true },
		replacement, span: verdict.span, appliedAt: Date.now(),
	};
	const previous = cache.getRelationshipCorrections(candidate.note);
	removeRelationshipEvidence(cache, edge, item => item.note === candidate.note && !item.correctionId);
	if (replacement) upsertRelationshipEvidence(cache, replacement, {
		note: candidate.note, bodyHash: source.bodyHash, span: verdict.span, correctionId: correction.id,
	});
	cache.setRelationshipCorrections(candidate.note, [...previous, correction]);
	return correction;
}

export async function undoLastRelationshipCorrection(plugin: SimpleGraphBuilderPlugin): Promise<boolean> {
	const cache = plugin.graphCache;
	const correction = cache.getLatestRelationshipCorrection();
	if (!correction) return false;
	const note = correction.evidence.note;
	const source = await readSource(plugin, note);
	const list = cache.getRelationshipCorrections(note);
	if (!source || source.bodyHash !== correction.evidence.bodyHash || !list.includes(correction) ||
		!cache.getNodeById(correction.original.source) || !cache.getNodeById(correction.original.target)) {
		throw new Error('The last correction belongs to an earlier note or relationship revision.');
	}
	if (correction.replacement) {
		const edge = cache.getEdgeById(relationshipId(correction.replacement));
		if (edge) removeRelationshipEvidence(cache, edge, item => item.note === note && item.correctionId === correction.id);
	}
	const originalId = correction.id.split('\u0000')[0];
	upsertRelationshipEvidence(cache, correction.original, correction.evidence, undefined, originalId);
	cache.setRelationshipCorrections(note, list.filter(item => item !== correction));
	await cache.flush();
	await syncCorrections(plugin, [correction]);
	return true;
}

async function syncCorrections(plugin: SimpleGraphBuilderPlugin, corrections: RelationshipCorrection[]): Promise<void> {
	if (!plugin.settings.enableEntityNotes || !plugin.settings.writeRelationshipsSection) return;
	const ids = new Set(corrections.flatMap(correction => [correction.original.source, correction.replacement?.source]));
	const nodes = [...ids].flatMap(id => {
		const node = id && plugin.graphCache.getNodeById(id);
		return node ? [node] : [];
	});
	try {
		await upsertEntityNotes(plugin, nodes);
	} catch (error) {
		console.error('Could not sync a corrected relationship to entity notes', error);
	}
}
