import { Modal, Notice, Setting } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import {
	applyRelationshipCorrection, checkOneRelationship, flagRelationship, readRelationshipForReview, relationshipReviewSources,
	reviewNextRelationships, undoLastRelationshipCorrection,
} from '../analysis/relationship-review';
import type { RelationshipReview, ReviewCandidate } from '../analysis/relationship-review';
import type { ReviewVerdict } from '../extraction/relationship-review';
import type { EvidenceSpan } from '../types';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function openRelationshipReview(plugin: SimpleGraphBuilderPlugin, edgeId: string): void {
	const sources = relationshipReviewSources(plugin, edgeId);
	if (sources.length) new RelationshipReviewModal(plugin, [], { edgeId, sources }).open();
	else new Notice('No eligible note source is available for this relationship.');
}

export function showRelationshipReviews(plugin: SimpleGraphBuilderPlugin, reviews: RelationshipReview[]): void {
	if (reviews.length) new RelationshipReviewModal(plugin, reviews).open();
	else new Notice('No unchecked relationship sources found in this batch.');
}

export async function openNextRelationshipReview(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	const notice = new Notice('Checking up to six relationships…', 0);
	try {
		showRelationshipReviews(plugin, await reviewNextRelationships(plugin));
	} catch (error) {
		new Notice(`Relationship review failed. ${errorMessage(error)}`);
	} finally {
		notice.hide();
	}
}

export async function undoRelationshipReview(plugin: SimpleGraphBuilderPlugin): Promise<void> {
	try {
		if (await undoLastRelationshipCorrection(plugin)) {
			new Notice('Restored the last relationship correction.');
			plugin.refreshRelationshipViews();
		} else new Notice('There is no relationship correction to undo.');
	} catch (error) {
		new Notice(errorMessage(error));
	}
}

class RelationshipReviewModal extends Modal {
	private closed = false;
	private busy = false;
	private changed = false;
	private selected: string;
	private candidate?: ReviewCandidate;

	constructor(
		private readonly plugin: SimpleGraphBuilderPlugin,
		private reviews: RelationshipReview[],
		private readonly manual?: { edgeId: string; sources: string[] },
	) {
		super(plugin.app);
		this.selected = manual?.sources[0] ?? '';
	}

	onOpen(): void {
		this.setTitle(this.manual ? 'Review relationship' : 'Relationship review');
		if (this.manual) void this.loadSource(this.selected);
		else this.render();
	}

	onClose(): void {
		this.closed = true;
		this.contentEl.empty();
		if (this.changed && !this.busy) this.plugin.refreshRelationshipViews();
	}

	private async perform(action: () => Promise<void>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.render();
		try {
			await action();
		} catch (error) {
			new Notice(errorMessage(error));
		} finally {
			this.busy = false;
			if (!this.closed) this.render();
			else if (this.changed) this.plugin.refreshRelationshipViews();
		}
	}

	private loadSource(note: string): Promise<void> {
		const id = this.manual?.edgeId;
		if (!id) return Promise.resolve();
		return this.perform(async () => {
			this.selected = note;
			this.candidate = undefined;
			this.reviews = [];
			this.candidate = await readRelationshipForReview(this.plugin, id, note);
		});
	}

	private render(): void {
		this.contentEl.empty();
		if (this.busy) {
			this.contentEl.createEl('p', { text: 'Working…' });
			return;
		}
		if (this.manual) this.renderManual(this.manual.edgeId, this.manual.sources);
		else if (!this.reviews.length) this.contentEl.createEl('p', { text: 'All suggested changes in this batch were applied.' });
		for (const review of this.reviews) this.renderVerdict(review);
	}

	private renderManual(edgeId: string, sources: string[]): void {
		if (sources.length > 1) {
			new Setting(this.contentEl).setName('Source note').addDropdown(dropdown => {
				for (const note of sources) dropdown.addOption(note, note);
				dropdown.setValue(this.selected).onChange(note => void this.loadSource(note));
			});
		}
		const candidate = this.candidate;
		if (!candidate) {
			this.contentEl.createEl('p', { text: 'This relationship source is no longer available.' });
			return;
		}
		this.showSource(candidate, this.reviews[0]?.verdict.span);
		new Setting(this.contentEl).addButton(button => button.setButtonText('Flag for next review').onClick(() => {
			const flagged = flagRelationship(this.plugin, edgeId, candidate.note);
			new Notice(flagged ? 'Relationship flagged for the next batch.' : 'The relationship could not be flagged.');
		})).addButton(button => button.setButtonText('Check excerpt with model').onClick(() => void this.perform(async () => {
			this.reviews = await checkOneRelationship(this.plugin, edgeId, candidate.note);
			if (this.reviews[0]) this.candidate = this.reviews[0].candidate;
			else new Notice('The source changed. Open the relationship again.');
		})));

		let verb = candidate.verb;
		let reverse = false;
		new Setting(this.contentEl).setName('Relationship verb').addText(text => text.setValue(verb)
			.onChange(value => { verb = value; }));
		new Setting(this.contentEl).setName('Reverse direction').addToggle(toggle => toggle.onChange(value => { reverse = value; }));
		new Setting(this.contentEl)
			.addButton(button => button.setButtonText('Retract this source').setWarning()
				.onClick(() => void this.apply(candidate, { kind: 'retract' })))
			.addButton(button => button.setButtonText('Apply correction').setCta()
				.onClick(() => void this.apply(candidate, { kind: 'replace', verb, reverse })));
	}

	private showSource(candidate: ReviewCandidate, span?: EvidenceSpan): void {
		this.contentEl.createEl('h3', { text: `${candidate.subject} ${candidate.verb} ${candidate.object}` });
		const link = this.contentEl.createEl('button', { text: candidate.note });
		link.addEventListener('click', () => void this.app.workspace.openLinkText(candidate.file.path, '', 'tab'));
		const quote = this.contentEl.createEl('blockquote');
		const start = span && span[0] - candidate.offset;
		const end = span && span[1] - candidate.offset;
		if (start !== undefined && end !== undefined && start >= 0 && end <= candidate.text.length) {
			quote.appendText(candidate.text.slice(0, start));
			quote.createEl('mark', { text: candidate.text.slice(start, end) });
			quote.appendText(candidate.text.slice(end));
		} else quote.setText(candidate.text);
	}

	private renderVerdict({ candidate, verdict }: RelationshipReview): void {
		if (!this.manual) this.showSource(candidate, verdict.span);
		if (verdict.kind === 'supported' || verdict.kind === 'unclear') {
			this.contentEl.createEl('p', { text: verdict.kind === 'supported' ? 'The excerpt supports this relationship.' : 'The excerpt is inconclusive.' });
			return;
		}
		const revised = verdict.reverse
			? `${candidate.object} ${verdict.verb} ${candidate.subject}`
			: `${candidate.subject} ${verdict.verb} ${candidate.object}`;
		const retraction = verdict.kind === 'retract';
		new Setting(this.contentEl)
			.setName(retraction ? 'The excerpt contradicts this relationship' : revised)
			.addButton(button => button.setButtonText(retraction ? 'Retract this source' : 'Apply suggested correction')
				.onClick(() => void this.apply(candidate, verdict)));
	}

	private apply(candidate: ReviewCandidate, verdict: ReviewVerdict): Promise<void> {
		return this.perform(async () => {
			await applyRelationshipCorrection(this.plugin, candidate, verdict);
			this.changed = true;
			this.reviews = this.reviews.filter(item => item.candidate !== candidate);
			new Notice('Relationship correction saved. Use Undo last relationship correction to restore it.');
			if (this.manual) this.close();
		});
	}
}
