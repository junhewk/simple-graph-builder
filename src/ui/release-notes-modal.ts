import { App, Component, MarkdownRenderer, Modal } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import changelog from '../../CHANGELOG.md';
import { CHANGELOG_URL, ReleaseSection, parseChangelog, releaseNotesToShow, withAbsoluteLinks } from '../release-notes';

/**
 * Record the running version and, after a feature update, show what changed.
 * A fresh install records its version without showing anything.
 */
export async function showReleaseNotesIfUpdated(plugin: SimpleGraphBuilderPlugin, freshInstall: boolean): Promise<void> {
	const current = plugin.manifest.version;
	const lastSeen = plugin.settings.lastSeenVersion;
	if (lastSeen === current) return;

	const sections = freshInstall ? [] : releaseNotesToShow(parseChangelog(changelog), lastSeen, current);
	// Recorded before showing, so a reload with the window open does not show it again.
	plugin.settings.lastSeenVersion = current;
	await plugin.saveSettings();

	if (sections.length && plugin.settings.showReleaseNotes) {
		new ReleaseNotesModal(plugin.app, sections, async () => {
			plugin.settings.showReleaseNotes = false;
			await plugin.saveSettings();
		}).open();
	}
}

export class ReleaseNotesModal extends Modal {
	private readonly component = new Component();

	constructor(
		app: App,
		private readonly sections: ReleaseSection[],
		private readonly onTurnOff: () => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle('What\'s new in Simple Graph Builder');
		this.component.load();

		for (const section of this.sections) {
			const el = contentEl.createDiv();
			void MarkdownRenderer.render(this.app, `### ${section.heading}\n\n${withAbsoluteLinks(section.body)}`, el, '', this.component);
		}

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.createEl('button', { text: 'Don\'t show after updates' })
			.addEventListener('click', () => {
				void this.onTurnOff();
				this.close();
			});
		buttonContainer.createEl('button', { text: 'Full changelog' })
			.addEventListener('click', () => window.open(CHANGELOG_URL, '_blank'));
		buttonContainer.createEl('button', { text: 'Close', cls: 'mod-cta' })
			.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}
}
