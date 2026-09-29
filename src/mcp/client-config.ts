/**
 * Copy-paste connection settings for each agent client. Pure string building,
 * so the exact text users paste is covered by tests.
 */

export const SERVER_NAME = 'obsidian-graph';

export function endpointUrl(port: number): string {
	return `http://127.0.0.1:${port}/mcp`;
}

/** One command; `--scope user` makes it available in every project. */
export function claudeCodeCommand(port: number, token: string): string {
	return `claude mcp add --transport http --scope user ${SERVER_NAME} ${endpointUrl(port)} --header "Authorization: Bearer ${token}"`;
}

/** A block for ~/.codex/config.toml. */
export function codexConfig(port: number, token: string): string {
	return [
		`[mcp_servers.${tomlKey(SERVER_NAME)}]`,
		`url = ${tomlString(endpointUrl(port))}`,
		`http_headers = { "Authorization" = ${tomlString(`Bearer ${token}`)} }`,
	].join('\n');
}

/**
 * The `mcpServers` entry for claude_desktop_config.json. Built with
 * JSON.stringify so Windows backslashes in the bridge path come out escaped.
 */
export function claudeDesktopConfig(nodePath: string, bridgePath: string, port: number, token: string): string {
	return JSON.stringify({
		mcpServers: {
			[SERVER_NAME]: {
				command: nodePath || 'node',
				args: [bridgePath],
				env: { SGB_MCP_URL: endpointUrl(port), SGB_MCP_TOKEN: token },
			},
		},
	}, null, 2);
}

function tomlKey(key: string): string {
	return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

function tomlString(value: string): string {
	return JSON.stringify(value);
}
