import { Notice } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { isAnalyzingVault } from '../commands/analyze';
import { getExtractionConfigError } from '../extraction/providers/models';
import { isRelationshipReviewRunning, reviewNextRelationships } from './relationship-review';

const REVIEW_INTERVAL = 24 * 60 * 60 * 1000;
const STARTUP_DELAY = 10_000;
const BUSY_DELAY = 60_000;

export async function runBackgroundRelationshipReview(
	plugin: SimpleGraphBuilderPlugin, stopped: () => boolean = () => false,
): Promise<number> {
	const cancelled = () => stopped() || !plugin.settings.autoCorrectRelationships;
	const cache = plugin.graphCache;
	const lastRequest = cache.getRelationshipReview().lastBackgroundRequestAt;
	if (cancelled() || getExtractionConfigError(plugin.settings) ||
		(lastRequest !== undefined && Date.now() - lastRequest < REVIEW_INTERVAL)) return 0;

	const reviews = await reviewNextRelationships(plugin, {
		autoApply: true,
		cancelled,
		beforeRequest: async () => {
			// Persist the charge boundary before sending anything. Failures and
			// restarting Obsidian stay within the same daily request budget.
			cache.setRelationshipReview({ ...cache.getRelationshipReview(), lastBackgroundRequestAt: Date.now() });
			await cache.flush();
		},
	});
	return reviews.filter(review => review.applied).length;
}

/** One timeout while enabled. Graph traversal and model work run off startup. */
export class BackgroundRelationshipReview {
	private timer?: number;
	private running = false;
	private disposed = false;

	constructor(private readonly plugin: SimpleGraphBuilderPlugin) {}

	updateSettings(): void {
		if (this.stopped()) {
			if (this.timer !== undefined) window.clearTimeout(this.timer);
			this.timer = undefined;
			return;
		}
		if (this.timer !== undefined || this.running) return;
		const last = this.plugin.graphCache.getRelationshipReview().lastBackgroundRequestAt;
		const remaining = last === undefined ? 0 : last + REVIEW_INTERVAL - Date.now();
		const delay = Math.max(STARTUP_DELAY, Math.min(remaining, REVIEW_INTERVAL));
		this.schedule(delay);
	}

	dispose(): void {
		this.disposed = true;
		this.updateSettings();
	}

	private stopped(): boolean {
		return this.disposed || !this.plugin.settings.autoCorrectRelationships || !!getExtractionConfigError(this.plugin.settings);
	}

	private schedule(delay: number): void {
		if (this.stopped()) return;
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, delay);
	}

	private async run(): Promise<void> {
		if (this.stopped()) return;
		if (isAnalyzingVault() || isRelationshipReviewRunning(this.plugin)) {
			this.schedule(BUSY_DELAY);
			return;
		}
		this.running = true;
		try {
			const count = await runBackgroundRelationshipReview(this.plugin, () => this.stopped());
			if (count && !this.stopped()) {
				this.plugin.refreshRelationshipViews();
				new Notice(`Automatically corrected ${count} relationship source${count === 1 ? '' : 's'}. Use Undo last relationship correction to restore a change.`);
			}
		} catch (error) {
			console.debug('Simple Graph Builder: background relationship review failed', error);
		} finally {
			this.running = false;
			this.schedule(REVIEW_INTERVAL);
		}
	}
}
