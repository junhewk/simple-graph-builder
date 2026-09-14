import { Notice } from 'obsidian';
import type { App, TFile } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { isPluginManagedNote } from '../sync';

export const NATIVE_EXCLUSION_ERROR = 'Obsidian excluded files could not be checked. Turn off “Respect Obsidian excluded files” in Simple Graph Builder settings to resume analysis.';

export type AnalysisEligibility =
	| { status: 'allowed' }
	| { status: 'excluded'; reason: string }
	| { status: 'unavailable'; reason: string };

export function parseExcludedPatterns(text: string): string[] {
	return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function normalizePath(path: string): string {
	return path.normalize('NFC').replace(/\\/g, '/').replace(/^(?:\.\/|\/)+/, '');
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compilePattern(pattern: string): RegExp {
	const path = normalizePath(pattern).replace(/\/+$/, '');
	if (!/[?*]/.test(path)) return new RegExp(`^${escapeRegex(path)}(?:/.*)?$`, 'iu');
	const segments = path.split('/');
	let source = '^';
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const last = i === segments.length - 1;
		if (segment === '**') {
			source += last ? '.*' : '(?:[^/]+/)*';
		} else {
			for (const char of segment) {
				source += char === '*' ? '[^/]*' : char === '?' ? '[^/]' : escapeRegex(char);
			}
			if (!last) source += '/';
		}
	}
	return new RegExp(`${source}$`, 'iu');
}

const compiled = new WeakMap<readonly string[], { key: string; matchers: RegExp[] }>();

/** Root-anchored globs; only a whole ** segment crosses folder boundaries. */
export function matchesExcludedPath(path: string, patterns: readonly string[]): boolean {
	const key = JSON.stringify(patterns);
	let entry = compiled.get(patterns);
	if (!entry || entry.key !== key) {
		entry = { key, matchers: patterns.map(p => p.trim()).filter(Boolean).map(compilePattern) };
		compiled.set(patterns, entry);
	}
	const normalized = normalizePath(path);
	return entry.matchers.some(matcher => matcher.test(normalized));
}

// Obsidian implements this at runtime, but it is not in the public typings.
// Keep the optional API isolated here and retain its receiver and native paths.
function nativeCache(app: App): { isUserIgnored?: (path: string) => boolean } {
	return app.metadataCache as unknown as { isUserIgnored?: (path: string) => boolean };
}

export function supportsNativeExclusions(app: App): boolean {
	return typeof nativeCache(app).isUserIgnored === 'function';
}

export function getAnalysisEligibility(plugin: SimpleGraphBuilderPlugin, file: TFile): AnalysisEligibility {
	if (isPluginManagedNote(plugin, file)) {
		return { status: 'excluded', reason: 'This is a plugin-managed entity note' };
	}
	if (matchesExcludedPath(file.path, plugin.settings.excludedPatterns)) {
		return { status: 'excluded', reason: 'This note matches an excluded file or folder pattern' };
	}
	if (plugin.settings.respectObsidianExcludedFiles) {
		try {
			const cache = nativeCache(plugin.app);
			if (typeof cache.isUserIgnored !== 'function') throw new Error('Native exclusion matcher unavailable');
			const ignored = cache.isUserIgnored(file.path);
			if (typeof ignored !== 'boolean') throw new Error('Invalid native exclusion result');
			if (ignored) return { status: 'excluded', reason: 'This note is excluded by Obsidian' };
		} catch {
			return { status: 'unavailable', reason: NATIVE_EXCLUSION_ERROR };
		}
	}
	lastUnavailableNotice.delete(plugin);
	return { status: 'allowed' };
}

const lastUnavailableNotice = new WeakMap<object, string>();

/** An unavailable native matcher must not produce a notice on every save. */
export function reportAnalysisUnavailable(plugin: SimpleGraphBuilderPlugin, reason: string): void {
	if (lastUnavailableNotice.get(plugin) === reason) return;
	lastUnavailableNotice.set(plugin, reason);
	new Notice(reason);
}
