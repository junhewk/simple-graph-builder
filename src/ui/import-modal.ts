/**
 * Importing or updating a med-lit project: choose the folder, see what will
 * happen, run it, then deal with anything that needed a decision.
 *
 * Nothing touches the vault until the second step's button: reading the
 * project and planning the merge are free, so the preview shows the real
 * outcome -- including every page that will be kept because it was edited.
 */
import { App, Modal, Notice, Setting } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import {
	executeImport,
	ImportError,
	ImportReport,
	PreparedImport,
	prepareImport,
	removeImport,
} from '../import/controller';
import { canReadExternalFolders } from '../import/reader';
import type { FileActionKind } from '../import/plan';
import type { FileKey, ImportManifest } from '../import/types';

const KIND_LABELS: [FileActionKind, string][] = [
	['create', 'new'],
	['overwrite', 'updated'],
	['adopt', 'already up to date'],
	['unchanged', 'unchanged'],
	['trash', 'removed upstream (to trash)'],
	['keep-local', 'edited by you, unchanged upstream'],
	['conflict', 'edited by you AND changed upstream (kept yours)'],
	['locally-deleted', 'deleted by you (not restored)'],
	['occupied', 'blocked by an existing file'],
	['release', 'removed upstream, edited by you (kept, no longer tracked)'],
];

/** Decisions the person can overrule with "Use med-lit's version". */
const FORCEABLE = new Set<FileActionKind>(['conflict', 'locally-deleted', 'occupied', 'keep-local']);

function errorMessage(error: unknown): string {
	if (error instanceof ImportError) return error.message;
	console.error('Simple Graph Builder: med-lit import failed', error);
	return error instanceof Error ? error.message : String(error);
}

function summarize(counts: Record<FileActionKind, number>): string[] {
	return KIND_LABELS.filter(([kind]) => counts[kind] > 0).map(([kind, label]) => `${counts[kind]} ${label}`);
}

export class ImportModal extends Modal {
	private sourcePath: string;
	private folder = '';
	private prepared: PreparedImport | null = null;
	private confirmOlder = false;
	private useEmbeddings: boolean;
	private busy = false;

	constructor(app: App, private plugin: SimpleGraphBuilderPlugin, project?: ImportManifest) {
		super(app);
		const latest = project ?? [...plugin.imports.all()].sort((a, b) => b.importedAt - a.importedAt)[0];
		this.sourcePath = latest?.lastSourcePath ?? '';
		this.useEmbeddings = plugin.settings.enableEmbeddings;
	}

	onOpen(): void {
		this.titleEl.setText('Import med-lit project');
		this.renderSource();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// --- step 1: where ---

	private renderSource(error?: string): void {
		const { contentEl } = this;
		contentEl.empty();

		if (!canReadExternalFolders()) {
			contentEl.createEl('p', { text: 'Importing reads a med-lit project folder outside the vault, which needs the desktop app.' });
			return;
		}

		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Choose a med-lit project folder (the one containing .med-lit/). Importing the same project again ' +
				'later updates it: new and changed pages come in, pages you edited are kept.',
		});

		for (const manifest of this.plugin.imports.all()) {
			new Setting(contentEl)
				.setName(manifest.name)
				.setDesc(`Imported into "${manifest.vaultFolder}". Last read from ${manifest.lastSourcePath}`)
				.addButton(button => button.setButtonText('Use this folder').onClick(() => {
					this.sourcePath = manifest.lastSourcePath;
					this.renderSource();
				}));
		}

		new Setting(contentEl)
			.setName('Project folder')
			.setDesc('Absolute path, e.g. /Users/me/med-lit/My review')
			.addText(text => {
				text.setPlaceholder('/path/to/med-lit project').setValue(this.sourcePath).onChange(value => { this.sourcePath = value; });
				text.inputEl.addClass('sgb-setting-input-wide');
			});

		if (error) contentEl.createEl('p', { cls: 'sgb-import-error', text: error });

		new Setting(contentEl).addButton(button => button
			.setButtonText('Read project')
			.setCta()
			.onClick(() => void this.read()));
	}

	private async read(force?: ReadonlySet<FileKey>): Promise<void> {
		if (this.busy || !this.sourcePath.trim()) return;
		this.busy = true;
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: 'Reading the project...' });
		try {
			this.prepared = await prepareImport(this.plugin, this.sourcePath, { folder: this.folder || undefined, force });
			if (!this.folder) this.folder = this.prepared.plan.folder;
			this.confirmOlder = false;
			this.renderPreview();
		} catch (error) {
			this.renderSource(errorMessage(error));
		} finally {
			this.busy = false;
		}
	}

	// --- step 2: what will happen ---

	private renderPreview(): void {
		const prepared = this.prepared!;
		const { snapshot, plan, previous, counts } = prepared;
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h3', { text: snapshot.project.name });
		const facts = contentEl.createEl('ul');
		facts.createEl('li', {
			text: previous
				? `Update of the project imported into "${previous.vaultFolder}".`
				: 'New import.',
		});
		facts.createEl('li', {
			text: `${snapshot.kg.articleUids.length} articles, ${snapshot.kg.entities.length} entities, ` +
				`${snapshot.kg.relationships.length} relationships` +
				(snapshot.marker.lastUpdate ? `, bot update ${snapshot.marker.lastUpdate}` : '') + '.',
		});

		if (!previous) {
			new Setting(contentEl)
				.setName('Import into folder')
				.setDesc('Articles and wiki pages stay together in this folder. It cannot be changed after the first import.')
				.addText(text => text.setValue(this.folder).onChange(value => { this.folder = value; }))
				.addButton(button => button.setButtonText('Apply').onClick(() => void this.read()));
		}

		contentEl.createEl('h4', { text: 'Pages' });
		const list = contentEl.createEl('ul');
		for (const line of summarize(counts)) list.createEl('li', { text: line });

		const kept = plan.actions.filter(a => a.kind === 'conflict' || a.kind === 'occupied');
		if (kept.length > 0) {
			const details = contentEl.createEl('details');
			details.createEl('summary', { text: `${kept.length} page(s) will be kept as they are` });
			const keptList = details.createEl('ul');
			for (const action of kept.slice(0, 50)) keptList.createEl('li', { text: action.path });
		}

		if (snapshot.warnings.length > 0) {
			const details = contentEl.createEl('details');
			details.createEl('summary', { text: `${snapshot.warnings.length} note(s) about this snapshot` });
			const warnList = details.createEl('ul');
			for (const warning of snapshot.warnings) warnList.createEl('li', { text: warning });
		}

		if (plan.older) {
			new Setting(contentEl)
				.setName('This snapshot is older than the one imported last')
				.setDesc('Importing it rolls pages and the graph back to that state. Pages you edited are still kept.')
				.addToggle(toggle => toggle.setValue(this.confirmOlder).onChange(value => {
					this.confirmOlder = value;
					this.renderPreview();
				}));
		}

		if (this.plugin.settings.enableEmbeddings) {
			new Setting(contentEl)
				.setName('Match entities with embeddings')
				.setDesc('Also match differently named entities to your existing graph by embedding similarity ' +
					'(and LLM verification, if on). Costs API calls for entities not seen before. Off: exact names and aliases only.')
				.addToggle(toggle => toggle.setValue(this.useEmbeddings).onChange(value => { this.useEmbeddings = value; }));
		}

		const buttons = new Setting(contentEl);
		buttons.addButton(button => button.setButtonText('Back').onClick(() => this.renderSource()));
		buttons.addButton(button => button
			.setButtonText(previous ? 'Update' : 'Import')
			.setCta()
			.setDisabled(plan.older && !this.confirmOlder)
			.onClick(() => void this.run()));
	}

	private async run(): Promise<void> {
		if (this.busy || !this.prepared) return;
		this.busy = true;
		const { contentEl } = this;
		contentEl.empty();
		const status = contentEl.createEl('p', { text: 'Importing...' });
		try {
			const report = await executeImport(this.plugin, this.prepared, {
				useEmbeddings: this.useEmbeddings,
				onProgress: message => status.setText(message),
			});
			this.renderReport(report);
		} catch (error) {
			contentEl.empty();
			contentEl.createEl('p', { cls: 'sgb-import-error', text: errorMessage(error) });
			new Setting(contentEl).addButton(button => button.setButtonText('Back').onClick(() => this.renderSource()));
		} finally {
			this.busy = false;
		}
	}

	// --- step 3: what happened ---

	private renderReport(report: ImportReport): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl('h3', { text: `${report.isUpdate ? 'Updated' : 'Imported'} ${report.name}` });
		if (report.cancelled) contentEl.createEl('p', { text: 'Cancelled before every page was written; run the update again to finish.' });

		const pages = contentEl.createEl('ul');
		for (const line of summarize(report.counts)) pages.createEl('li', { text: line });

		const g = report.graph;
		contentEl.createEl('h4', { text: 'Knowledge graph' });
		const graph = contentEl.createEl('ul');
		graph.createEl('li', { text: `${g.nodesCreated} new entities, ${g.nodesShared} joined with entities already in your graph` });
		graph.createEl('li', { text: `${g.edgesCreated} new relationships, ${g.edgesShared} existing ones gained evidence` });
		if (g.nodesRemoved || g.edgesRemoved) {
			graph.createEl('li', { text: `${g.nodesRemoved} entities and ${g.edgesRemoved} relationships no longer supported were removed` });
		}
		if (report.reused > 0) graph.createEl('li', { text: `${report.reused} entities kept their earlier match` });
		if (g.suggestedMerges.length > 0) {
			graph.createEl('li', {
				text: `med-lit merged ${g.suggestedMerges.length} entit${g.suggestedMerges.length === 1 ? 'y' : 'ies'} that your graph still keeps apart: ` +
					g.suggestedMerges.slice(0, 5).map(m => `${this.nameOf(m.other)} → ${this.nameOf(m.keep)}`).join(', '),
			});
		}

		const decisions = report.outcomes.filter(o => FORCEABLE.has(o.kind) && o.kind !== 'keep-local');
		if (decisions.length > 0) {
			contentEl.createEl('h4', { text: 'Kept as they are' });
			contentEl.createEl('p', {
				cls: 'setting-item-description',
				text: 'These pages differ from med-lit\'s current version because of a change in the vault. ' +
					'Use med-lit\'s version to replace a page (yours goes nowhere else, so copy anything you need first).',
			});
			for (const outcome of decisions.slice(0, 30)) {
				new Setting(contentEl)
					.setName(outcome.path)
					.setDesc(KIND_LABELS.find(([k]) => k === outcome.kind)?.[1] ?? outcome.kind)
					.addButton(button => button.setButtonText('Use med-lit\'s version').onClick(() => void this.force([outcome.key])));
			}
			if (decisions.length > 1) {
				new Setting(contentEl).addButton(button => button
					.setButtonText(`Use med-lit's version for all ${decisions.length}`)
					.setWarning()
					.onClick(() => void this.force(decisions.map(o => o.key))));
			}
		}

		const failed = report.outcomes.filter(o => o.error);
		if (failed.length > 0) {
			contentEl.createEl('p', { cls: 'sgb-import-error', text: `${failed.length} page(s) could not be written; see the console.` });
		}

		new Setting(contentEl).addButton(button => button.setButtonText('Done').setCta().onClick(() => this.close()));
		this.plugin.updateStatusBar();
	}

	private nameOf(nodeId: string): string {
		return this.plugin.graphCache.getNodeById(nodeId)?.properties.name ?? nodeId;
	}

	/** Re-plan with these pages forced, then run straight away. */
	private async force(keys: FileKey[]): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		try {
			this.prepared = await prepareImport(this.plugin, this.sourcePath, { force: new Set(keys) });
		} catch (error) {
			new Notice(errorMessage(error));
			return;
		} finally {
			this.busy = false;
		}
		await this.run();
	}
}

/** Removing an import: from the graph only, or its untouched pages too. */
export class RemoveImportModal extends Modal {
	constructor(app: App, private plugin: SimpleGraphBuilderPlugin, private manifest: ImportManifest, private onDone: () => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText(`Remove ${this.manifest.name}`);
		contentEl.createEl('p', {
			text: 'Its entities and relationships leave the graph, except where your own notes support them too. ' +
				'You can keep the pages in the vault, or move the ones you have not edited to the trash.',
		});

		const run = (trashFiles: boolean) => async () => {
			this.close();
			try {
				const result = await removeImport(this.plugin, this.manifest.projectId, { trashFiles });
				new Notice(
					`Removed ${this.manifest.name} from the graph (${result.graph.nodesRemoved} entities, ${result.graph.edgesRemoved} relationships).` +
					(trashFiles ? `\n${result.trashed} pages moved to the trash${result.kept.length ? `, ${result.kept.length} edited pages kept` : ''}.` : '')
				);
			} catch (error) {
				new Notice(errorMessage(error));
			}
			this.plugin.updateStatusBar();
			this.onDone();
		};

		new Setting(contentEl)
			.addButton(button => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(button => button.setButtonText('Remove, keep pages').onClick(() => void run(false)()))
			.addButton(button => button.setButtonText('Remove and trash pages').setWarning().onClick(() => void run(true)()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
