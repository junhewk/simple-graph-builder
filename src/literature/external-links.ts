import { Platform } from 'obsidian';
import { safeArticleUrl } from './results';

interface ExternalLinkEnvironment {
	desktop: boolean;
	loadShell(): { openExternal(url: string): Promise<void> } | undefined;
	open(url: string): void;
}

/** A URL action only: never request an article, download a file or touch the vault. */
export async function openArticleExternally(value: string, environment?: ExternalLinkEnvironment): Promise<void> {
	const url = safeArticleUrl(value);
	if (!url) throw new Error('This article does not have a valid HTTP or HTTPS destination.');
	const env = environment ?? {
		desktop: Platform.isDesktopApp,
		loadShell: () => {
			const requireNode = (window as unknown as { require?: (id: string) => unknown }).require;
			if (!requireNode) return undefined;
			const module = requireNode('electron') as { shell?: { openExternal(url: string): Promise<void> } };
			return module.shell;
		},
		open: (target: string) => { window.open(target, '_blank', 'noopener,noreferrer'); },
	};
	if (env.desktop) {
		const shell = env.loadShell();
		if (!shell) throw new Error('The external browser could not be opened. Copy the article URL to your browser.');
		await shell.openExternal(url);
	} else env.open(url);
}
