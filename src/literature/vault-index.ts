import { TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { normalizeUnicode } from '../types';
import { identifierKeys, identifiers } from './results';
import type { PublicationIds, SourceNoteRef } from './types';

export interface VaultReferenceEntry { path: string; identifiers: PublicationIds }

/** Exact identifiers only. A title match is insufficient to assert a paper is in the vault. */
export class VaultReferenceIndex {
	private byKey = new Map<string, VaultReferenceEntry[]>();

	constructor(entries: VaultReferenceEntry[]) {
		for (const entry of entries) {
			for (const key of identifierKeys(entry.identifiers)) {
				const list = this.byKey.get(key) ?? [];
				list.push(entry);
				this.byKey.set(key, list);
			}
		}
	}

	find(ids: PublicationIds): string[] {
		const candidates = identifierKeys(ids).flatMap(key => this.byKey.get(key) ?? []);
		return [...new Set(candidates.filter(entry =>
			!(['doi', 'pmid', 'pmcid'] as const).some(key => ids[key] && entry.identifiers[key] && ids[key] !== entry.identifiers[key])
		).map(entry => entry.path))];
	}
}

/** Obsidian metadata-cache reads only; no prose scans and no file writes. */
export function readVaultReferences(plugin: SimpleGraphBuilderPlugin): { index: VaultReferenceIndex; reference(path: string): SourceNoteRef } {
	const entries = new Map<string, VaultReferenceEntry>();
	const add = (path: string, ids: PublicationIds) => {
		const key = normalizeUnicode(path);
		const before = entries.get(key);
		const defined = Object.fromEntries(Object.entries(ids).filter(([, value]) => value));
		entries.set(key, { path, identifiers: { ...before?.identifiers, ...defined } });
	};
	for (const file of plugin.app.vault.getMarkdownFiles()) {
		if (!(file instanceof TFile) || !plugin.querySource.isVisible(file.path)) continue;
		const metadata: unknown = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		add(file.path, identifiers(metadata));
	}
	for (const manifest of plugin.imports.all()) {
		for (const [key, file] of Object.entries(manifest.files)) {
			if (key.startsWith('source:') && entries.has(normalizeUnicode(file.path))) add(file.path, identifiers({ uid: key.slice(7) }));
		}
	}
	for (const node of plugin.graphCache.getAllNodes()) {
		// Only a document/note denotes an article; identifiers on a concept do not identify all its sources.
		if (!['DOCUMENT', 'NOTE'].includes(node.entityType) || node.sourceNotes.length !== 1) continue;
		if (entries.has(normalizeUnicode(node.sourceNotes[0]))) add(node.sourceNotes[0], identifiers(node.properties));
	}
	return {
		index: new VaultReferenceIndex([...entries.values()]),
		reference: path => {
			const entry = entries.get(normalizeUnicode(path));
			return { path: entry?.path ?? path, identifiers: { ...entry?.identifiers } };
		},
	};
}
