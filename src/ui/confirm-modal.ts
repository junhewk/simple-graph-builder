import { App, Modal } from 'obsidian';

/**
 * A simple confirmation modal that replaces window.confirm().
 */
export class ConfirmModal extends Modal {
	private message: string;
	private onConfirm: () => void | Promise<void>;

	constructor(app: App, message: string, onConfirm: () => void | Promise<void>) {
		super(app);
		this.message = message;
		this.onConfirm = onConfirm;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('p', { text: this.message });

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => this.close());
		buttonContainer.createEl('button', { text: 'Confirm', cls: 'mod-warning' })
			.addEventListener('click', () => {
				void this.onConfirm();
				this.close();
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
