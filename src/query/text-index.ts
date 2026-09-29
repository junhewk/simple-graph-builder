/**
 * In-memory BM25F index.
 *
 * Fields are weighted by folding them into one pseudo term frequency before
 * the usual BM25 saturation (the "simple BM25F" formulation): a title hit
 * counts as several body hits, but a term repeated fifty times in the body
 * still saturates. Only postings are kept, never the text itself.
 *
 * Storage is compact on purpose. A 10k-note vault has millions of
 * (term, note) pairs; as JS Map entries they cost over half a gigabyte, as
 * typed arrays about 8 bytes each. Deletes leave tombstones that are swept
 * once they make up a quarter of the index.
 */
import { tokenize } from './tokenize';

export interface IndexFields {
	[field: string]: string | readonly string[];
}

export interface TextHit {
	key: string;
	score: number;
	/** Query tokens found in this document. */
	matched: Set<string>;
}

const K1 = 1.2;
const B = 0.75;
const MIN_COMPACT = 256;

class Posting {
	docs = new Int32Array(4);
	tfs = new Float32Array(4);
	length = 0;
	/** Postings pointing at live documents. */
	live = 0;

	push(doc: number, tf: number): void {
		if (this.length === this.docs.length) {
			const docs = new Int32Array(this.length * 2);
			docs.set(this.docs);
			this.docs = docs;
			const tfs = new Float32Array(this.length * 2);
			tfs.set(this.tfs);
			this.tfs = tfs;
		}
		this.docs[this.length] = doc;
		this.tfs[this.length++] = tf;
		this.live++;
	}
}

interface Doc {
	key: string;
	length: number;
	termIds: Int32Array;
	tfs: Float32Array;
}

export class TextIndex {
	private readonly boosts: Record<string, number>;
	private readonly termIds = new Map<string, number>();
	private terms: string[] = [];
	private postings: Posting[] = [];
	private docs: (Doc | null)[] = [];
	private readonly keyToDoc = new Map<string, number>();
	private dead = 0;
	private totalLength = 0;

	constructor(boosts: Record<string, number>) {
		this.boosts = boosts;
	}

	get size(): number {
		return this.keyToDoc.size;
	}

	has(key: string): boolean {
		return this.keyToDoc.has(key);
	}

	keys(): string[] {
		return [...this.keyToDoc.keys()];
	}

	/** Add or replace a document. */
	set(key: string, fields: IndexFields): void {
		this.delete(key);

		const counts = new Map<number, number>();
		let length = 0;
		for (const [field, value] of Object.entries(fields)) {
			const boost = this.boosts[field] ?? 1;
			const texts = typeof value === 'string' ? [value] : value;
			for (const text of texts) {
				for (const token of tokenize(text)) {
					const id = this.intern(token);
					counts.set(id, (counts.get(id) ?? 0) + boost);
					length += boost;
				}
			}
		}

		const doc: Doc = {
			key,
			length,
			termIds: Int32Array.from(counts.keys()),
			tfs: Float32Array.from(counts.values()),
		};
		const index = this.docs.length;
		this.docs.push(doc);
		this.keyToDoc.set(key, index);
		for (let i = 0; i < doc.termIds.length; i++) {
			this.postings[doc.termIds[i]].push(index, doc.tfs[i]);
		}
		this.totalLength += length;
	}

	delete(key: string): boolean {
		const index = this.keyToDoc.get(key);
		if (index === undefined) return false;
		const doc = this.docs[index]!;
		for (const id of doc.termIds) this.postings[id].live--;
		this.totalLength -= doc.length;
		this.docs[index] = null;
		this.keyToDoc.delete(key);
		this.dead++;
		if (this.dead >= MIN_COMPACT && this.dead > this.docs.length / 4) this.compact();
		return true;
	}

	rename(from: string, to: string): void {
		const index = this.keyToDoc.get(from);
		if (index === undefined || from === to) return;
		this.delete(to);
		this.keyToDoc.delete(from);
		this.keyToDoc.set(to, index);
		this.docs[index]!.key = to;
	}

	clear(): void {
		this.termIds.clear();
		this.terms = [];
		this.postings = [];
		this.docs = [];
		this.keyToDoc.clear();
		this.dead = 0;
		this.totalLength = 0;
	}

	/** Tokens of one document, for explanations. */
	termsOf(key: string): ReadonlySet<string> | undefined {
		const index = this.keyToDoc.get(key);
		if (index === undefined) return undefined;
		const doc = this.docs[index]!;
		return new Set(Array.from(doc.termIds, id => this.terms[id]));
	}

	/**
	 * Score documents against query tokens. Repeated query tokens count once:
	 * the Korean bigram tokenizer repeats tokens for words like "하하하", and that
	 * should not multiply their weight.
	 */
	search(queryTokens: readonly string[], limit: number, filter?: (key: string) => boolean): TextHit[] {
		const count = this.keyToDoc.size;
		if (count === 0) return [];
		const avgLength = this.totalLength / count || 1;
		const scores = new Map<number, number>();
		const matched = new Map<number, Set<string>>();

		for (const term of new Set(queryTokens)) {
			const id = this.termIds.get(term);
			if (id === undefined) continue;
			const posting = this.postings[id];
			if (posting.live === 0) continue;
			const idf = Math.log(1 + (count - posting.live + 0.5) / (posting.live + 0.5));
			for (let i = 0; i < posting.length; i++) {
				const docIndex = posting.docs[i];
				const doc = this.docs[docIndex];
				if (!doc) continue;
				const tf = posting.tfs[i];
				const norm = tf + K1 * (1 - B + B * (doc.length / avgLength));
				scores.set(docIndex, (scores.get(docIndex) ?? 0) + idf * ((tf * (K1 + 1)) / norm));
				let set = matched.get(docIndex);
				if (!set) {
					set = new Set();
					matched.set(docIndex, set);
				}
				set.add(term);
			}
		}

		const hits: TextHit[] = [];
		for (const [docIndex, score] of scores) {
			const key = this.docs[docIndex]!.key;
			if (filter && !filter(key)) continue;
			hits.push({ key, score, matched: matched.get(docIndex) ?? new Set() });
		}
		hits.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
		return hits.slice(0, limit);
	}

	private intern(token: string): number {
		let id = this.termIds.get(token);
		if (id === undefined) {
			id = this.terms.length;
			this.termIds.set(token, id);
			this.terms.push(token);
			this.postings.push(new Posting());
		}
		return id;
	}

	/** Drop tombstones: renumber live documents and rebuild postings. */
	private compact(): void {
		const live = this.docs.filter((d): d is Doc => d !== null);
		this.docs = live;
		this.keyToDoc.clear();
		for (const posting of this.postings) {
			posting.length = 0;
			posting.live = 0;
		}
		live.forEach((doc, index) => {
			this.keyToDoc.set(doc.key, index);
			for (let i = 0; i < doc.termIds.length; i++) this.postings[doc.termIds[i]].push(index, doc.tfs[i]);
		});
		this.dead = 0;
	}
}
