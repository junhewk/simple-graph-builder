/**
 * MCP JSON-RPC dispatch, independent of HTTP.
 *
 * Serves both protocol eras on one endpoint:
 *
 * - **Modern** (2026-07-28): stateless. Every request carries its protocol
 *   version in `_meta`, mirrored in the `MCP-Protocol-Version`, `Mcp-Method`
 *   and `Mcp-Name` headers, which must match the body.
 * - **Legacy** (2025-03-26 … 2025-11-25): an `initialize` handshake first.
 *   No session ids are minted, which those revisions allow, so the legacy
 *   path is stateless too.
 *
 * Hand-rolled rather than built on the SDK: the surface is five methods, and
 * the SDK would add its schema library and HTTP framework to the bundle.
 */

export const MODERN_VERSIONS = ['2026-07-28'] as const;
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;
export const SUPPORTED_VERSIONS: readonly string[] = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const ErrorCode = {
	ParseError: -32700,
	InvalidRequest: -32600,
	MethodNotFound: -32601,
	InvalidParams: -32602,
	InternalError: -32603,
	HeaderMismatch: -32020,
	UnsupportedProtocolVersion: -32022,
} as const;

export interface ToolDefinition {
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations?: Record<string, unknown>;
}

export interface ToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
}

export interface ToolRegistry {
	list(): ToolDefinition[];
	/** Undefined when no tool has that name. */
	call(name: string, args: Record<string, unknown>): Promise<ToolResult> | undefined;
}

export interface ServerIdentity {
	name: string;
	title?: string;
	version: string;
}

/** What the HTTP layer should send back. A null body means 202 with no content. */
export interface Reply {
	status: number;
	body: unknown;
}

/** Header names are lower-cased by the caller (node does this already). */
export type Headers = Record<string, string | string[] | undefined>;

type Id = string | number;

export class McpDispatcher {
	constructor(
		private readonly identity: ServerIdentity,
		private readonly tools: ToolRegistry,
		private readonly instructions: () => string
	) {}

	async handle(message: unknown, headers: Headers): Promise<Reply> {
		if (Array.isArray(message)) {
			return error(400, null, ErrorCode.InvalidRequest, 'Batch requests are not supported.');
		}
		if (!isObject(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
			return error(400, null, ErrorCode.InvalidRequest, 'Expected a JSON-RPC 2.0 request or notification.');
		}

		const method = message.method;
		const params = isObject(message.params) ? message.params : {};
		const hasId = 'id' in message;
		const id = message.id;
		if (hasId && typeof id !== 'string' && typeof id !== 'number') {
			return error(400, null, ErrorCode.InvalidRequest, 'Request id must be a string or number.');
		}

		// Notifications: nothing this server needs to act on.
		if (!hasId) return { status: 202, body: null };

		const meta = isObject(params._meta) ? params._meta : {};
		const headerVersion = header(headers, 'mcp-protocol-version');
		const modern = method !== 'initialize' &&
			(META_VERSION in meta || (headerVersion !== undefined && (MODERN_VERSIONS as readonly string[]).includes(headerVersion)));

		if (modern) {
			const rejection = validateModern(id as Id, method, params, meta, headers);
			if (rejection) return rejection;
		} else if (method !== 'initialize' && headerVersion !== undefined && !(LEGACY_VERSIONS as readonly string[]).includes(headerVersion)) {
			return error(400, id as Id, ErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', {
				supported: SUPPORTED_VERSIONS,
				requested: headerVersion,
			});
		}

		try {
			const result = await this.dispatch(method, params);
			if (result === undefined) {
				// Modern servers answer an unknown method with 404 so clients can
				// tell it apart from a legacy server that lacks the endpoint.
				return error(modern ? 404 : 200, id as Id, ErrorCode.MethodNotFound, `Method not found: ${method}`);
			}
			if ('invalid' in result) {
				return error(modern ? 400 : 200, id as Id, ErrorCode.InvalidParams, result.invalid);
			}
			const body: Record<string, unknown> = { resultType: 'complete', ...result.ok };
			if (modern) body._meta = { [META_SERVER_INFO]: this.serverInfo() };
			return { status: 200, body: { jsonrpc: '2.0', id, result: body } };
		} catch (e) {
			console.error('[simple-graph-builder] MCP request failed', e);
			return error(500, id as Id, ErrorCode.InternalError, e instanceof Error ? e.message : 'Internal error');
		}
	}

	private async dispatch(method: string, params: Record<string, unknown>): Promise<{ ok: Record<string, unknown> } | { invalid: string } | undefined> {
		switch (method) {
			case 'initialize': {
				const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
				const version = (LEGACY_VERSIONS as readonly string[]).includes(requested) ? requested : LEGACY_VERSIONS[0];
				return {
					ok: {
						protocolVersion: version,
						capabilities: { tools: { listChanged: false } },
						serverInfo: this.serverInfo(),
						instructions: this.instructions(),
					},
				};
			}
			case 'server/discover':
				return {
					ok: {
						supportedVersions: SUPPORTED_VERSIONS,
						capabilities: { tools: { listChanged: false } },
						instructions: this.instructions(),
						_meta: { [META_SERVER_INFO]: this.serverInfo() },
					},
				};
			case 'ping':
				return { ok: {} };
			case 'tools/list':
				return { ok: { tools: this.tools.list() } };
			case 'tools/call': {
				if (typeof params.name !== 'string') return { invalid: 'tools/call needs a tool name.' };
				const args = params.arguments === undefined ? {} : params.arguments;
				if (!isObject(args)) return { invalid: 'Tool arguments must be an object.' };
				const pending = this.tools.call(params.name, args);
				if (!pending) return { invalid: `Unknown tool: ${params.name}` };
				return { ok: { ...(await pending) } };
			}
			default:
				return undefined;
		}
	}

	private serverInfo(): ServerIdentity {
		return { ...this.identity };
	}
}

/**
 * Modern-era checks: required `_meta`, a supported version, and headers that
 * agree with the body (so nothing routing on headers can be fooled).
 */
function validateModern(id: Id, method: string, params: Record<string, unknown>, meta: Record<string, unknown>, headers: Headers): Reply | null {
	const version = meta[META_VERSION];
	if (typeof version !== 'string' || !isObject(meta[META_CAPABILITIES])) {
		return error(400, id, ErrorCode.InvalidParams,
			`Requests must carry _meta["${META_VERSION}"] and _meta["${META_CAPABILITIES}"].`);
	}
	if (!(MODERN_VERSIONS as readonly string[]).includes(version)) {
		return error(400, id, ErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', {
			supported: SUPPORTED_VERSIONS,
			requested: version,
		});
	}

	const headerVersion = header(headers, 'mcp-protocol-version');
	if (headerVersion !== version) {
		return mismatch(id, `MCP-Protocol-Version header ${quote(headerVersion)} does not match body ${quote(version)}`);
	}
	const headerMethod = header(headers, 'mcp-method');
	if (headerMethod !== method) {
		return mismatch(id, `Mcp-Method header ${quote(headerMethod)} does not match body ${quote(method)}`);
	}
	if (method === 'tools/call') {
		const raw = header(headers, 'mcp-name');
		const decoded = raw === undefined ? undefined : decodeHeaderValue(raw);
		if (decoded === null) return mismatch(id, 'Mcp-Name header is not valid base64');
		if (decoded !== params.name) {
			return mismatch(id, `Mcp-Name header ${quote(decoded)} does not match body ${quote(params.name)}`);
		}
	}
	return null;
}

/** `=?base64?...?=` sentinel values are base64 UTF-8; everything else is literal. */
export function decodeHeaderValue(value: string): string | null {
	const match = /^=\?base64\?(.*)\?=$/.exec(value);
	if (!match) return value;
	try {
		const bytes = Uint8Array.from(atob(match[1]), c => c.charCodeAt(0));
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

function header(headers: Headers, name: string): string | undefined {
	const value = headers[name];
	return Array.isArray(value) ? value[0] : value;
}

function mismatch(id: Id, message: string): Reply {
	return error(400, id, ErrorCode.HeaderMismatch, `Header mismatch: ${message}`);
}

function error(status: number, id: Id | null, code: number, message: string, data?: unknown): Reply {
	const err: Record<string, unknown> = { code, message };
	if (data !== undefined) err.data = data;
	const body: Record<string, unknown> = { jsonrpc: '2.0', error: err };
	if (id !== null) body.id = id;
	return { status, body };
}

function quote(value: unknown): string {
	return value === undefined ? '(missing)' : `'${String(value)}'`;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
