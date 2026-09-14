import assert from 'node:assert/strict';
import './graph-harness';
import { SettingsTab } from '../src/ui/settings-tab';
import SimpleGraphBuilderPlugin from '../src/main';
import { Setting, pendingDebounces, flushDebounces, allBodies, resetBodies, notices } from './obsidian-stub';
import { fakeSyncPlugin } from './vault-stub';
import { DEFAULT_SETTINGS, CURRENT_SETTINGS_VERSION } from '../src/settings';
import type { TFile } from 'obsidian';

// A tiny UI harness lets both actual settings renderers install their event
// handlers. Changes below go through those handlers, not direct settings edits.
class Element {
	style = {};
	empty() {}
	createDiv() { return new Element(); }
	createEl() { return new Element(); }
	appendText() {}
	setText() {}
	addClass() {}
	removeClass() {}
	toggle() {}
}
class Control {
	inputEl = new Element();
	value: unknown;
	disabled = false;
	change: (value: any) => unknown = () => undefined;
	setValue(value: unknown) { this.value = value; return this; }
	setDisabled(value: boolean) { this.disabled = value; return this; }
	onChange(fn: (value: any) => unknown) { this.change = fn; return this; }
	setPlaceholder() { return this; }
	addOption() { return this; }
	setLimits() { return this; }
	setDynamicTooltip() { return this; }
	setButtonText() { return this; }
	setWarning() { return this; }
	setCta() { return this; }
	removeCta() { return this; }
	setClass() { return this; }
	onClick() { return this; }
}
type Rendered = Setting & { name: string; controls: Control[] };
const rendered: Rendered[] = [];
Object.assign(Setting.prototype, {
	get descEl() { return new Element(); },
	setName(this: Rendered, name: string) { this.name = name; this.controls = []; rendered.push(this); return this; },
	setDesc() { return this; },
	setHeading() { return this; },
	addTextArea: addControl, addToggle: addControl, addText: addControl,
	addDropdown: addControl, addSlider: addControl, addButton: addControl,
});
function addControl(this: Rendered, configure: (control: Control) => void) {
	const control = new Control();
	this.controls.push(control);
	configure(control);
	return this;
}
function control(name: string): Control {
	const matches = rendered.filter(item => item.name === name);
	assert.equal(matches.length, 1, `one ${name} setting`);
	return matches[0].controls[0];
}

async function main() {
	for (const ui of ['declarative', 'legacy']) {
		const ctx = fakeSyncPlugin({ enableEntityNotes: false });
		await ctx.graphCache.ensureLoaded();
		const { plugin, vault } = ctx;
		plugin.saveSettings = SimpleGraphBuilderPlugin.prototype.saveSettings.bind(plugin);
		await plugin.saveData({ graph: { nodes: [], edges: [], version: 3 }, hashes: { hashes: [{ path: 'old.md', hash: 'old', analyzedAt: 1 }] } });
		const before = ctx.latest();
		let enumerations = 0;
		vault.getMarkdownFiles = () => { enumerations++; return []; };
		const cache = plugin.app.metadataCache as unknown as { isUserIgnored?: () => boolean };
		cache.isUserIgnored = () => false;
		const tab = new SettingsTab(plugin.app, plugin);
		tab.containerEl = new Element() as never;
		function render() {
			rendered.length = 0;
			if (ui === 'legacy') tab.display();
			else {
				const group = tab.getSettingDefinitions().find(item => 'heading' in item && item.heading === 'Analysis');
				assert.ok(group && 'items' in group);
				for (const definition of group.items.filter(item => item.name.includes('Excluded') || item.name.includes('Respect Obsidian'))) {
					const setting = new Setting(undefined) as unknown as import('obsidian').Setting;
					definition.render?.(setting.setName(definition.name));
				}
			}
		}
		render();
		assert.equal(control('Respect Obsidian excluded files').value, false);
		await control('Excluded files and folders').change(' skills/** \r\n\n**/SKILL.md ');
		await control('Respect Obsidian excluded files').change(true);
		assert.deepEqual(ctx.latest().settings.excludedPatterns, ['skills/**', '**/SKILL.md']);
		assert.equal(ctx.latest().settings.respectObsidianExcludedFiles, true);
		assert.deepEqual(ctx.latest().graph, before.graph);
		assert.deepEqual(ctx.latest().hashes, before.hashes);
		render();
		assert.equal(control('Excluded files and folders').value, 'skills/**\n**/SKILL.md');
		assert.equal(control('Respect Obsidian excluded files').value, true);
		delete cache.isUserIgnored;
		render();
		assert.equal(control('Respect Obsidian excluded files').disabled, false, 'an unavailable enabled option can still be disabled');
		await control('Respect Obsidian excluded files').change(false);
		assert.equal(control('Respect Obsidian excluded files').disabled, true);
		await tab.setControlValue('respectObsidianExcludedFiles', true);
		assert.equal(plugin.settings.respectObsidianExcludedFiles, false, 'cannot enable unavailable native matching');
		await control('Excluded files and folders').change(' \n ');
		assert.deepEqual(ctx.latest().settings.excludedPatterns, []);
		assert.equal(enumerations, 0, 'opening and editing settings never enumerate the vault');
	}

	// Exercise real loadSettings migration and the real registered modify hook.
	const ctx = fakeSyncPlugin({}, { settings: { ...DEFAULT_SETTINGS, settingsVersion: 4, excludedPatterns: undefined, respectObsidianExcludedFiles: undefined, autoAnalyzeOnSave: true, apiProvider: 'ollama' } });
	const { vault } = ctx;
	let modify: (file: TFile) => void = () => { throw new Error('modify hook missing'); };
	ctx.plugin.app.vault.on = ((_event: string, callback: typeof modify) => { modify = callback; return {}; }) as never;
	ctx.plugin.app.workspace = { onLayoutReady() {} } as never;
	const plugin = new SimpleGraphBuilderPlugin(ctx.plugin.app, { id: 'simple-graph-builder', dir: '.obsidian/plugins/simple-graph-builder' } as never);
	plugin.loadData = ctx.plugin.loadData;
	plugin.saveData = ctx.plugin.saveData;
	await plugin.onload();
	assert.deepEqual(plugin.settings.excludedPatterns, []);
	assert.equal(plugin.settings.respectObsidianExcludedFiles, false);
	assert.equal(plugin.settings.settingsVersion, CURRENT_SETTINGS_VERSION);
	const allowed = vault.seed('notes/allowed.md', 'A long note that should not be read after the exclusion setting changes while this note waits.');
	const excluded = vault.seed('skills/config.md', 'configuration');
	plugin.settings.excludedPatterns = ['skills/**'];
	pendingDebounces.clear();
	modify(allowed);
	assert.equal(pendingDebounces.size, 1);
	modify(excluded);
	assert.equal(pendingDebounces.size, 1, 'excluded events cannot replace an eligible pending note');
	plugin.settings.excludedPatterns.push('notes/**');
	let reads = 0;
	plugin.app.vault.read = async () => { reads++; throw new Error('unexpected read'); };
	resetBodies();
	notices.length = 0;
	await flushDebounces();
	assert.equal(reads, 0, 'queued callback checks current settings');
	assert.equal(allBodies.length, 0);
	assert.deepEqual(notices, []);
	modify(excluded);
	assert.equal(pendingDebounces.size, 0, 'excluded events are dropped before scheduling');
	plugin.settings.excludedPatterns = [];
	modify(allowed);
	allowed.path = 'skills/renamed.md';
	plugin.settings.excludedPatterns = ['skills/**'];
	await flushDebounces();
	assert.equal(reads, 0, 'queued callback checks the current path');
	plugin.settings.autoAnalyzeOnSave = false;
	plugin.settings.respectObsidianExcludedFiles = true;
	modify(vault.seed('notes/disabled.md', ''));
	assert.deepEqual(notices, [], 'disabled auto-analysis does not produce compatibility notices');
	console.log('exclusion-settings: all checks passed');
}

main().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
