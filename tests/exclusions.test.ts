import assert from 'node:assert/strict';
import './graph-harness';
import { matchesExcludedPath, parseExcludedPatterns, getAnalysisEligibility, supportsNativeExclusions } from '../src/analysis/exclusions';
import { fakeSyncPlugin } from './vault-stub';

const cases: [string, string, boolean][] = [
	['skills', 'skills/a.md', true],
	['skills/', 'skills/nested/a.md', true],
	['skills', 'skillset/a.md', false],
	['skills', 'notes/skills/a.md', false],
	['skills/**', 'skills/a.md', true],
	['skills/**', 'skills/nested/a.md', true],
	['skills/**', 'skills.md', false],
	['templates/*.md', 'templates/a.md', true],
	['templates/*.md', 'templates/nested/a.md', false],
	['**/SKILL.md', 'SKILL.md', true],
	['**/SKILL.md', 'notes/deep/skill.md', true],
	['**/SKILL.md', 'notes/SKILLS.md', false],
	['*.md', 'notes/a.md', false],
	['notes/draft.md', 'notes/draft.md', true],
	['notes/draft.md', 'notes/draftXmd', false],
	['a/**/b.md', 'a/b.md', true],
	['a/**/b.md', 'a/deep/nested/b.md', true],
	['a/?/b.md', 'a/한/b.md', true],
	['a/?/b.md', 'a/한국/b.md', false],
	['a/?/b.md', 'a///b.md', false],
	['[draft](a)+$.md', '[draft](a)+$.md', true],
	['[draft](a)+$.md', 'draftaaa.md', false],
	['!draft.md', '!draft.md', true],
	['#draft.md', '#draft.md', true],
	['notes/**', 'NOTES/A.MD', true],
	['한국/**', '한국/문서.md'.normalize('NFD'), true],
	['한국/**'.normalize('NFD'), '한국/문서.md', true],
	['./skills\\**', 'skills\\a.md', true],
	['two  spaces', 'two spaces/a.md', false],
	['', 'notes/a.md', false],
	['  ', 'notes/a.md', false],
];

for (const [pattern, path, expected] of cases) {
	assert.equal(matchesExcludedPath(path, [pattern]), expected, `${pattern} -> ${path}`);
}
assert.deepEqual(parseExcludedPatterns(' skills/** \r\n\n **/SKILL.md\n'), ['skills/**', '**/SKILL.md']);
assert.equal(matchesExcludedPath('a.md', []), false);
const patterns = ['skills/**'];
assert.equal(matchesExcludedPath('skills/a.md', patterns), true);
patterns[0] = 'notes/**';
assert.equal(matchesExcludedPath('skills/a.md', patterns), false, 'in-place edits invalidate the matcher cache');
assert.equal(matchesExcludedPath('notes/a.md', patterns), true);

const { plugin, vault } = fakeSyncPlugin();
const file = vault.seed('한국/Skill.md'.normalize('NFD'), '');
assert.equal(supportsNativeExclusions(plugin.app), false);
assert.equal(getAnalysisEligibility(plugin, file).status, 'allowed', 'native integration defaults off');
plugin.settings.respectObsidianExcludedFiles = true;
assert.equal(getAnalysisEligibility(plugin, file).status, 'unavailable');
const cache = plugin.app.metadataCache as unknown as { ignored: boolean; isUserIgnored: (path: string) => boolean };
cache.ignored = true;
cache.isUserIgnored = function(path) {
	assert.equal(this, cache, 'native matcher retains its receiver');
	assert.equal(path, file.path, 'native matcher receives the original path');
	return this.ignored;
};
assert.equal(supportsNativeExclusions(plugin.app), true);
assert.equal(getAnalysisEligibility(plugin, file).status, 'excluded');
cache.ignored = false;
assert.equal(getAnalysisEligibility(plugin, file).status, 'allowed', 'native settings are not snapshotted');
cache.isUserIgnored = () => { throw new Error('broken API'); };
assert.equal(getAnalysisEligibility(plugin, file).status, 'unavailable');
cache.isUserIgnored = () => undefined as unknown as boolean;
assert.equal(getAnalysisEligibility(plugin, file).status, 'unavailable', 'invalid results cannot silently allow analysis');
plugin.settings.respectObsidianExcludedFiles = false;
assert.equal(getAnalysisEligibility(plugin, file).status, 'allowed');
plugin.settings.excludedPatterns = ['한국/**'];
assert.equal(getAnalysisEligibility(plugin, file).status, 'excluded');
const managed = vault.seed('Elsewhere/generated.md', '', { 'sgb-id': 'concept:test' });
plugin.settings.enableEntityNotes = false;
assert.equal(getAnalysisEligibility(plugin, managed).status, 'excluded', 'managed markers remain protected when write-back is off');
console.log('exclusions: all checks passed');
