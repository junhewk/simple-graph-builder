/**
 * Agent access: owns the MCP server's lifecycle, its token, and the Claude
 * Desktop bridge file. The settings tab reads status and connection snippets
 * from here.
 */
import { FileSystemAdapter, Platform } from 'obsidian';
import type SimpleGraphBuilderPlugin from '../main';
import { BRIDGE_FILENAME, BRIDGE_SOURCE } from './bridge';
import { claudeCodeCommand, claudeDesktopConfig, codexConfig, endpointUrl } from './client-config';
import { buildInstructions } from './instructions';
import { McpDispatcher } from './protocol';
import { HttpModule, McpHttpServer } from './server';
import { createToolRegistry } from './tools';

const TOKEN_STORAGE_KEY = 'simple-graph-builder-mcp-token';

export type McpStatus =
	| { state: 'off' }
	| { state: 'unsupported' }
	| { state: 'starting' }
	| { state: 'running'; port: number }
	| { state: 'error'; message: string };

export interface ConnectionSnippets {
	url: string;
	claudeCode: string;
	codex: string;
	claudeDesktop: string | null;
}

export class McpController {
	private server: McpHttpServer | null = null;
	private current: McpStatus = { state: 'off' };

	constructor(private readonly plugin: SimpleGraphBuilderPlugin) {}

	get status(): McpStatus {
		return this.current;
	}

	get supported(): boolean {
		return loadNodeHttp() !== null;
	}

	async start(): Promise<void> {
		if (this.server?.running) return;
		const http = loadNodeHttp();
		if (!http) {
			this.set({ state: 'unsupported' });
			return;
		}
		this.set({ state: 'starting' });

		const engine = this.plugin.queryEngine;
		const vaultName = this.plugin.app.vault.getName();
		const dispatcher = new McpDispatcher(
			{ name: 'simple-graph-builder', title: `Obsidian vault "${vaultName}"`, version: this.plugin.manifest.version },
			createToolRegistry(engine),
			() => {
				const overview = engine.overview();
				return buildInstructions(vaultName, { notes: overview.notes.total, entities: overview.entities });
			}
		);
		this.token(); // make sure one exists before anything can connect
		const server = new McpHttpServer({ http, port: this.plugin.settings.mcpPort, token: () => this.token(), dispatcher });

		try {
			const port = await server.start();
			this.server = server;
			this.set({ state: 'running', port });
			// Index up front so the first agent query is not the one that waits.
			void engine.ensureIndexed();
			await this.writeBridge();
		} catch (e) {
			const code = (e as { code?: string }).code;
			this.set({
				state: 'error',
				message: code === 'EADDRINUSE'
					? `Port ${this.plugin.settings.mcpPort} is in use (another vault or app?). Pick another port.`
					: `Could not start: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (server) await server.stop();
		this.set({ state: 'off' });
	}

	async restart(): Promise<void> {
		await this.stop();
		if (this.plugin.settings.mcpEnabled) await this.start();
	}

	/** The bearer token, created on first use. */
	token(): string {
		const app = this.plugin.app as AppWithLocalStorage;
		if (typeof app.loadLocalStorage === 'function' && typeof app.saveLocalStorage === 'function') {
			const stored = app.loadLocalStorage(TOKEN_STORAGE_KEY);
			if (typeof stored === 'string' && stored) return stored;
			const token = generateToken();
			app.saveLocalStorage(TOKEN_STORAGE_KEY, token);
			return token;
		}
		if (!this.plugin.settings.mcpToken) {
			this.plugin.settings.mcpToken = generateToken();
			void this.plugin.saveSettings();
		}
		return this.plugin.settings.mcpToken;
	}

	/** Where the token lives, for the settings page to say so. */
	get tokenIsLocal(): boolean {
		return typeof (this.plugin.app as AppWithLocalStorage).saveLocalStorage === 'function';
	}

	/** Invalidates every client's configuration. Takes effect on the next request. */
	async regenerateToken(): Promise<void> {
		const token = generateToken();
		const app = this.plugin.app as AppWithLocalStorage;
		if (typeof app.saveLocalStorage === 'function') {
			app.saveLocalStorage(TOKEN_STORAGE_KEY, token);
		} else {
			this.plugin.settings.mcpToken = token;
			await this.plugin.saveSettings();
		}
	}

	snippets(): ConnectionSnippets {
		const port = this.current.state === 'running' ? this.current.port : this.plugin.settings.mcpPort;
		const token = this.token();
		const bridge = this.bridgePath();
		return {
			url: endpointUrl(port),
			claudeCode: claudeCodeCommand(port, token),
			codex: codexConfig(port, token),
			claudeDesktop: bridge ? claudeDesktopConfig(this.plugin.settings.mcpNodePath, bridge, port, token) : null,
		};
	}

	private bridgeVaultPath(): string | null {
		const dir = this.plugin.manifest.dir;
		return dir ? `${dir}/${BRIDGE_FILENAME}` : null;
	}

	/** Absolute path of the bridge script, for the Claude Desktop config. */
	bridgePath(): string | null {
		const adapter = this.plugin.app.vault.adapter;
		const vaultPath = this.bridgeVaultPath();
		if (!vaultPath || !(adapter instanceof FileSystemAdapter)) return null;
		return adapter.getFullPath(vaultPath);
	}

	private async writeBridge(): Promise<void> {
		const path = this.bridgeVaultPath();
		if (!path) return;
		const adapter = this.plugin.app.vault.adapter;
		try {
			if ((await adapter.exists(path)) && (await adapter.read(path)) === BRIDGE_SOURCE) return;
			await adapter.write(path, BRIDGE_SOURCE);
		} catch (e) {
			console.error('[simple-graph-builder] could not write the MCP bridge', e);
		}
	}

	private set(status: McpStatus): void {
		this.current = status;
	}
}

interface AppWithLocalStorage {
	loadLocalStorage?: (key: string) => unknown;
	saveLocalStorage?: (key: string, value: unknown) => void;
}

/**
 * Node's http module, on desktop only. Desktop Obsidian runs in Electron with
 * Node integration, and `window.require` is how a plugin reaches Node
 * built-ins there. This is the plugin's only Node access, and it is never
 * reached on mobile, where the plugin keeps working without agent access.
 */
function loadNodeHttp(): HttpModule | null {
	if (!Platform.isDesktopApp) return null;
	const nodeRequire = (window as unknown as { require?: (id: string) => unknown }).require;
	if (typeof nodeRequire !== 'function') return null;
	try {
		return nodeRequire('http') as HttpModule;
	} catch {
		return null;
	}
}

function generateToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
