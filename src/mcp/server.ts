/**
 * Local Streamable HTTP endpoint for MCP.
 *
 * Listens on 127.0.0.1 only, and every request must carry the bearer token.
 * Host and Origin are checked against the loopback address, so a web page
 * cannot reach the server by DNS rebinding. Only POST with a JSON body is
 * accepted and no CORS headers are sent, so a browser cannot make a request
 * the server will act on.
 *
 * Node's `http` module is injected rather than imported: Obsidian's review
 * rules forbid Node imports in plugins that also run on mobile, and tests
 * pass node's own module.
 */
import type { Headers, McpDispatcher } from './protocol';

export const MAX_BODY_BYTES = 1024 * 1024;
export const MCP_PATH = '/mcp';

/** The slice of node's `http` module this server uses. */
export interface HttpModule {
	createServer(listener: (req: IncomingRequest, res: OutgoingResponse) => void): HttpServer;
}

export interface IncomingRequest {
	method?: string;
	url?: string;
	headers: Headers;
	on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
	on(event: 'end' | 'error', listener: (arg?: unknown) => void): unknown;
}

export interface OutgoingResponse {
	writeHead(status: number, headers?: Record<string, string>): unknown;
	end(body?: string): unknown;
	headersSent?: boolean;
}

export interface HttpServer {
	listen(port: number, host: string, callback: () => void): unknown;
	close(callback?: (err?: Error) => void): unknown;
	on(event: 'error', listener: (err: Error & { code?: string }) => void): unknown;
	on(event: 'connection', listener: (socket: Socket) => void): unknown;
	address(): { port: number } | string | null;
}

interface Socket {
	destroy(): void;
	on(event: 'close', listener: () => void): unknown;
}

export interface McpServerOptions {
	http: HttpModule;
	port: number;
	/** Read per request, so a regenerated token takes effect immediately. */
	token: () => string;
	dispatcher: McpDispatcher;
}

export class McpHttpServer {
	private server: HttpServer | null = null;
	private readonly sockets = new Set<Socket>();
	private boundPort = 0;

	constructor(private readonly options: McpServerOptions) {}

	get port(): number {
		return this.boundPort;
	}

	get running(): boolean {
		return this.server !== null;
	}

	/** Resolves with the bound port; rejects with the listen error (e.g. EADDRINUSE). */
	start(): Promise<number> {
		if (this.server) return Promise.resolve(this.boundPort);
		const server = this.options.http.createServer((req, res) => void this.handle(req, res));
		server.on('connection', socket => {
			this.sockets.add(socket);
			socket.on('close', () => this.sockets.delete(socket));
		});

		return new Promise((resolve, reject) => {
			server.on('error', err => {
				if (this.server === server) return;
				reject(err);
			});
			server.listen(this.options.port, '127.0.0.1', () => {
				const address = server.address();
				this.boundPort = typeof address === 'object' && address ? address.port : this.options.port;
				this.server = server;
				resolve(this.boundPort);
			});
		});
	}

	stop(): Promise<void> {
		const server = this.server;
		if (!server) return Promise.resolve();
		this.server = null;
		return new Promise(resolve => {
			server.close(() => resolve());
			// Keep-alive connections would hold close() open indefinitely.
			for (const socket of this.sockets) socket.destroy();
			this.sockets.clear();
		});
	}

	private async handle(req: IncomingRequest, res: OutgoingResponse): Promise<void> {
		try {
			const path = (req.url ?? '').split('?')[0];
			if (path !== MCP_PATH) return send(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });

			// DNS rebinding: a hostile page resolving its own name to 127.0.0.1
			// still sends its own Host and Origin.
			const allowedHosts = [`127.0.0.1:${this.boundPort}`, `localhost:${this.boundPort}`];
			const host = first(req.headers.host);
			if (!host || !allowedHosts.includes(host.toLowerCase())) return sendRpcError(res, 403, 'Forbidden host.');
			const origin = first(req.headers.origin);
			if (origin !== undefined && !allowedHosts.some(h => origin.toLowerCase() === `http://${h}`)) {
				return sendRpcError(res, 403, 'Forbidden origin.');
			}

			if (req.method !== 'POST') {
				return send(res, 405, { error: 'Only POST is supported.' }, { Allow: 'POST' });
			}

			if (!this.authorized(first(req.headers.authorization))) {
				return sendRpcError(res, 401,
					'Missing or wrong bearer token. Copy the connection settings again from Simple Graph Builder → Agent access.');
			}

			const contentType = first(req.headers['content-type']) ?? '';
			if (!/^application\/json\b/i.test(contentType)) return sendRpcError(res, 415, 'Content-Type must be application/json.');

			const text = await readBody(req);
			if (text === null) return sendRpcError(res, 413, `Request body over ${MAX_BODY_BYTES} bytes.`);

			let message: unknown;
			try {
				message = JSON.parse(text);
			} catch {
				return send(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
			}

			const reply = await this.options.dispatcher.handle(message, req.headers);
			if (reply.body === null) {
				res.writeHead(reply.status);
				res.end();
				return;
			}
			send(res, reply.status, reply.body);
		} catch (e) {
			console.error('[simple-graph-builder] MCP HTTP handler failed', e);
			if (!res.headersSent) sendRpcError(res, 500, 'Internal error');
		}
	}

	private authorized(header: string | undefined): boolean {
		const expected = this.options.token();
		if (!expected || !header) return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		return !!match && constantTimeEqual(match[1], expected);
	}
}

/** Resolves to the body, or null once it exceeds MAX_BODY_BYTES. */
function readBody(req: IncomingRequest): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Uint8Array[] = [];
		let size = 0;
		let done = false;
		req.on('data', (chunk: Uint8Array) => {
			if (done) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				done = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (done) return;
			done = true;
			const all = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				all.set(chunk, offset);
				offset += chunk.length;
			}
			resolve(new TextDecoder().decode(all));
		});
		req.on('error', err => {
			if (!done) reject(err instanceof Error ? err : new Error(String(err)));
		});
	});
}

function send(res: OutgoingResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
	res.end(JSON.stringify(body));
}

/** Transport-level failure as a JSON-RPC error without an id (the request was not read). */
function sendRpcError(res: OutgoingResponse, status: number, message: string): void {
	send(res, status, { jsonrpc: '2.0', error: { code: -32600, message } });
}

function first(value: string | string[] | undefined): string | undefined {
	return Array.isArray(value) ? value[0] : value;
}

export function constantTimeEqual(a: string, b: string): boolean {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	let diff = x.length ^ y.length;
	for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
	return diff === 0;
}
