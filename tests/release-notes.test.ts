/**
 * "What's new" after updates: which changelog sections to show, when, and
 * that the bundled changelog has a section for the version being released.
 */
import assert from 'node:assert/strict';
import './graph-harness';
import changelog from '../CHANGELOG.md';
import manifest from '../manifest.json';
import { compareVersions, parseChangelog, releaseNotesToShow, withAbsoluteLinks } from '../src/release-notes';
import { ReleaseNotesModal, showReleaseNotesIfUpdated } from '../src/ui/release-notes-modal';
import { DEFAULT_SETTINGS } from '../src/settings';
import type SimpleGraphBuilderPlugin from '../src/main';

const sample = [
	'# Changelog',
	'',
	'## Unreleased',
	'',
	'- not yet',
	'',
	'## 0.9.1',
	'',
	'- a fix',
	'',
	'## 0.9.0: big one',
	'',
	'- a feature, see [docs](docs/A.md#x)',
	'',
	'## 0.8.1: smaller',
	'',
	'- b',
	'',
	'## 0.8.0: graph',
	'',
	'- c',
	'',
	'## 0.7.2',
	'',
	'- d',
].join('\n');

async function main() {
	// Parsing: released sections only, newest first, headings kept as written.
	const sections = parseChangelog(sample);
	assert.deepEqual(sections.map(s => s.version), ['0.9.1', '0.9.0', '0.8.1', '0.8.0', '0.7.2']);
	assert.equal(sections[1].heading, '0.9.0: big one');
	assert.equal(sections[1].body, '- a feature, see [docs](docs/A.md#x)');

	const shown = (last: string, current: string) => releaseNotesToShow(sections, last, current).map(s => s.version);
	assert.deepEqual(shown('0.8.1', '0.9.0'), ['0.9.0'], 'a feature update');
	assert.deepEqual(shown('0.8.1', '0.9.1'), ['0.9.1', '0.9.0'], 'skipping the .0 still shows it');
	assert.deepEqual(shown('0.9.0', '0.9.1'), [], 'a fix release is not announced');
	assert.deepEqual(shown('0.9.0', '0.9.0'), []);
	assert.deepEqual(shown('0.9.1', '0.9.0'), [], 'a downgrade is not announced');
	assert.deepEqual(shown('0.7.2', '0.9.1'), ['0.9.1', '0.9.0', '0.8.1'], 'at most three');
	assert.deepEqual(shown('', '0.9.0'), ['0.9.0'], 'an install from before release notes sees only this feature release');
	assert.deepEqual(shown('', '0.9.1'), ['0.9.1', '0.9.0']);

	assert.ok(compareVersions('0.10.0', '0.9.9') > 0, 'numeric, not lexical');

	// Links: relative ones point at the repository, others are left alone.
	assert.equal(
		withAbsoluteLinks('[a](docs/A.md#x) [b](https://example.com) [c](#top) [d](./CHANGELOG.md)'),
		'[a](https://github.com/junhewk/simple-graph-builder/blob/master/docs/A.md#x) [b](https://example.com) [c](#top) ' +
			'[d](https://github.com/junhewk/simple-graph-builder/blob/master/CHANGELOG.md)'
	);

	// Release guard: the version in manifest.json has its own changelog section,
	// so the window never comes up empty for a feature release.
	const real = parseChangelog(changelog);
	assert.equal(real[0].version, manifest.version, 'CHANGELOG.md starts with a section for the manifest version');
	assert.ok(real[0].body.length > 0);

	// Startup: a fresh install records its version and shows nothing; an
	// update shows the window once; the setting turns it off.
	const opened: string[][] = [];
	(ReleaseNotesModal.prototype as unknown as { open: () => void }).open = function (this: unknown) {
		opened.push((this as { sections: { version: string }[] }).sections.map(s => s.version));
	};
	const fakePlugin = (settings: Partial<typeof DEFAULT_SETTINGS>) => {
		let saves = 0;
		const plugin = {
			manifest: { version: manifest.version },
			settings: { ...DEFAULT_SETTINGS, ...settings },
			app: {},
			saveSettings: async () => { saves++; },
		};
		return { plugin: plugin as unknown as SimpleGraphBuilderPlugin, saves: () => saves };
	};

	{
		const { plugin, saves } = fakePlugin({});
		await showReleaseNotesIfUpdated(plugin, true);
		assert.equal(plugin.settings.lastSeenVersion, manifest.version);
		assert.equal(saves(), 1);
		assert.deepEqual(opened, [], 'fresh install');

		await showReleaseNotesIfUpdated(plugin, false);
		assert.equal(saves(), 1, 'nothing to do on the next start');
	}
	{
		const { plugin } = fakePlugin({ lastSeenVersion: '' });
		await showReleaseNotesIfUpdated(plugin, false);
		assert.equal(opened.length, 1, 'an update from before release notes');
		assert.equal(opened[0][0], manifest.version);
		await showReleaseNotesIfUpdated(plugin, false);
		assert.equal(opened.length, 1, 'shown once');
	}
	{
		opened.length = 0;
		const { plugin } = fakePlugin({ lastSeenVersion: '0.1.0', showReleaseNotes: false });
		await showReleaseNotesIfUpdated(plugin, false);
		assert.deepEqual(opened, [], 'turned off');
		assert.equal(plugin.settings.lastSeenVersion, manifest.version, 'still recorded');
	}

	console.log('ok   release notes');
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
