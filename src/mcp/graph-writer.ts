/**
 * Agents adding to the graph: the plugin side of the extraction tools.
 *
 * The agent reads a note and extracts from it with its own model, so the user
 * needs no API key here. This hands the agent the note and the same rules a
 * provider gets, then checks what comes back with the same parser and merges
 * it the way the analyze command does.
 *
 * Off unless the user turns on `mcpGraphWrites`. It changes the graph and, if
 * vault write-back is on, what write-back writes; never a note's text.
 */
import { TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { getAnalysisEligibility } from '../analysis/exclusions';
import { applyExtraction, isAnalyzingVault, planVaultAnalysis } from '../commands/analyze';
import { parseExtraction, validateEnvelope } from '../extraction/llm-client';
import { buildAgentExtractionInstructions, truncateContent } from '../extraction/prompts';
import { getExtractionConfigError } from '../extraction/providers/models';
import { computeNoteHashes, getNoteHash, hasNoteChangedByHashes, loadHashes, saveHashes, updateNoteHash } from '../graph/hashes';
import { stripFrontmatter } from '../sync/note-content';
import { isNoteNode } from '../types';
import type { NotFound } from '../query/types';

/** Same floor as the analyze commands. */
const MIN_BODY_CHARS = 50;
const DEFAULT_MAX_CHARS = 40000;
const EXISTING_ENTITY_LIMIT = 150;

export type NoteStatus = 'new' | 'changed' | 'unchanged';

export interface PendingNotes {
	notes: { path: string; status: 'new' | 'changed' }[];
	/** Notes waiting in all, including those past `limit`. */
	pending: number;
	up_to_date: number;
	too_short: number;
}

export interface ExtractionTask {
	note: string;
	/** Pass back to submit_extraction; refused if the note changed meanwhile. */
	hash: string;
	status: NoteStatus;
	instructions: string;
	text: string;
	truncated: boolean;
	existing_entities: string[];
	existing_entity_count: number;
}

export interface SubmitResult {
	note: string;
	received: { entities: number; relationships: number };
	added: { entities: number; merged_entities: number; relationships: number };
	dropped: { item: string; problem: string }[];
}

export class GraphWriter {
	/** Submissions run one at a time: each reads and saves the hash table. */
	private queue: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly plugin: SimpleGraphBuilderPlugin,
		/** Whether the read-only tools may serve a note; entities only from hidden notes stay hidden. */
		private readonly isVisible: (path: string) => boolean
	) {}

	get enabled(): boolean {
		return this.plugin.settings.mcpGraphWrites;
	}

	async pending(options: { limit?: number; folder?: string } = {}): Promise<PendingNotes | NotFound> {
		const plan = await planVaultAnalysis(this.plugin);
		if (plan.unavailable) return { error: plan.unavailable };
		const prefix = options.folder ? normalizeFolder(options.folder) : '';
		const files = prefix ? plan.files.filter(f => f.path.normalize('NFC').startsWith(prefix)) : plan.files;
		const hashes = await loadHashes(this.plugin);
		const limit = clamp(options.limit ?? 20, 1, 200);
		return {
			notes: files.slice(0, limit).map(f => ({ path: f.path, status: getNoteHash(hashes, f.path) ? 'changed' : 'new' })),
			pending: files.length,
			up_to_date: plan.unchanged,
			too_short: plan.tooShort,
		};
	}

	async task(ref: string, options: { maxChars?: number } = {}): Promise<ExtractionTask | NotFound> {
		const note = await this.readNote(ref);
		if ('error' in note) return note;
		const { file, content, body, hash } = note;

		const hashes = await loadHashes(this.plugin);
		const status: NoteStatus = !getNoteHash(hashes, file.path)
			? 'new'
			: hasNoteChangedByHashes(hashes, file.path, computeNoteHashes(content)) ? 'changed' : 'unchanged';
		const text = truncateContent(body, clamp(options.maxChars ?? DEFAULT_MAX_CHARS, 1000, 200000));
		const existing = this.existingEntityNames();

		return {
			note: file.path,
			hash,
			status,
			instructions: buildAgentExtractionInstructions(body, this.plugin.settings.extractionMode || 'standard'),
			text,
			truncated: text !== body,
			existing_entities: existing.slice(0, EXISTING_ENTITY_LIMIT),
			existing_entity_count: existing.length,
		};
	}

	submit(ref: string, hash: string, entities: unknown[], relationships: unknown[]): Promise<SubmitResult | NotFound> {
		const run = () => this.submitNow(ref, hash, entities, relationships);
		const next = this.queue.then(run, run);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async submitNow(ref: string, hash: string, entities: unknown[], relationships: unknown[]): Promise<SubmitResult | NotFound> {
		// A vault analysis holds its own copy of the hash table and saves it at
		// the end, which would drop the hash recorded here.
		if (isAnalyzingVault()) {
			return { error: 'Obsidian is analyzing the vault right now. Try again when it finishes.' };
		}

		const note = await this.readNote(ref);
		if ('error' in note) return note;
		const { file, content } = note;
		if (note.hash !== hash) {
			return { error: `"${file.path}" changed after get_extraction_task. Call get_extraction_task again and extract from the new text.` };
		}

		const payload = {
			entities: entities.map(item => withEmptyDescription(item)),
			relationships: relationships.map(item => withEmptyDescription(item)),
		};
		const envelope = validateEnvelope(payload);
		if (envelope.length) return { error: envelope.map(v => `${v.path}: ${v.message}`).join('; ') };
		const { result, dropped } = parseExtraction(payload);
		const problems = dropped.map(d => ({
			item: `${d.kind}[${d.index}]`,
			problem: d.violations.map(v => `${v.path.replace(/^\$\.\w+\[\d+\]\.?/, '') || 'item'}: ${v.message}`).join('; '),
		}));
		if (entities.length > 0 && result.nodes.length === 0) {
			return { error: `Nothing saved: every entity broke the rules. ${problems.map(p => `${p.item}: ${p.problem}`).join(' | ')}` };
		}

		// LLM verification of near matches calls the chat provider, which an
		// agent-only setup may not have configured. Embedding matching still runs.
		const settings = {
			...this.plugin.settings,
			enableLLMVerification: this.plugin.settings.enableLLMVerification && !getExtractionConfigError(this.plugin.settings),
		};
		const merged = await applyExtraction(this.plugin, file, content, result, settings);

		const hashes = await loadHashes(this.plugin);
		updateNoteHash(hashes, file.path, note.hash);
		await saveHashes(this.plugin, hashes);
		this.plugin.updateStatusBar();

		return {
			note: file.path,
			received: { entities: entities.length, relationships: relationships.length },
			added: { entities: merged.nodesAdded, merged_entities: merged.nodesMerged, relationships: merged.relationshipsAdded },
			dropped: problems,
		};
	}

	/** A note analysis may read, with its body hash. Refusals read like the query tools' "not found". */
	private async readNote(ref: string): Promise<{ file: TFile; content: string; body: string; hash: string } | NotFound> {
		const file = this.resolve(ref);
		if (!file) return { error: `No note to analyze matches "${ref}". Use a path from notes_to_analyze.` };
		const eligibility = getAnalysisEligibility(this.plugin, file);
		if (eligibility.status === 'unavailable') return { error: eligibility.reason };
		if (eligibility.status === 'excluded') return { error: `No note to analyze matches "${ref}". Use a path from notes_to_analyze.` };

		// A fresh read, not cachedRead: the hash is what decides whether a
		// submission still matches the note.
		const content = await this.plugin.app.vault.read(file);
		const body = stripFrontmatter(content).body;
		if (body.trim().length < MIN_BODY_CHARS) return { error: `"${file.path}" is too short to analyze.` };
		return { file, content, body, hash: computeNoteHashes(content).body };
	}

	private resolve(ref: string): TFile | null {
		const vault = this.plugin.app.vault;
		const path = ref.trim().replace(/^\/+/, '');
		for (const candidate of path.toLowerCase().endsWith('.md') ? [path] : [path, `${path}.md`]) {
			const direct = vault.getAbstractFileByPath(candidate);
			if (direct instanceof TFile) return direct;
			// macOS can hand Obsidian NFD file names; agents send NFC.
			const nfc = candidate.normalize('NFC');
			const match = vault.getMarkdownFiles().find(f => f.path.normalize('NFC') === nfc);
			if (match) return match;
		}
		return null;
	}

	/** Entities the read-only tools would serve, most-mentioned first. */
	private existingEntityNames(): string[] {
		return this.plugin.graphCache.getAllNodes()
			.filter(node => !isNoteNode(node))
			.map(node => ({ name: node.properties.name, notes: node.sourceNotes.filter(p => this.isVisible(p)).length }))
			.filter(entry => entry.notes > 0)
			.sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name))
			.map(entry => entry.name);
	}
}

/**
 * The provider schema requires `description`, so a model says "" when it has
 * nothing to add. Agents may leave it out instead.
 */
function withEmptyDescription(item: unknown): unknown {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
	const record = item as Record<string, unknown>;
	return record.description === undefined ? { ...record, description: '' } : item;
}

function normalizeFolder(folder: string): string {
	const trimmed = folder.normalize('NFC').trim().replace(/^\/+|\/+$/g, '');
	return trimmed ? `${trimmed}/` : '';
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, Math.floor(value)));
}
