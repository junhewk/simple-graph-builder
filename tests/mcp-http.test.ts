/**
 * The local MCP endpoint over real HTTP, and the stdio bridge Claude Desktop runs.
 *
 * Security properties checked here: loopback-only Host/Origin (DNS
 * rebinding), bearer token, POST + JSON only, body cap, and that excluded
 * notes never cross the wire.
 */
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { McpHttpServer, MAX_BODY_BYTES } from '../src/mcp/server';
import { McpDispatcher } from '../src/mcp/protocol';
import { createToolRegistry } from '../src/mcp/tools';
import { buildInstructions } from '../src/mcp/instructions';
import { BRIDGE_SOURCE } from '../src/mcp/bridge';
import { claudeCodeCommand, claudeDesktopConfig, codexConfig } from '../src/mcp/client-config';
import { QueryEngine } from '../src/query/engine';
import { graph, source } from './query-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

interface Response { status: number; headers: http.IncomingHttpHeaders; body: string }

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Response> {
	return new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port, method: options.method ?? 'POST', path: options.path ?? '/mcp', headers: options.headers }, res => {
			let body = '';
			res.setEncoding('utf8');
			res.on('data', d => { body += d; });
			res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on('error', reject);
		if (options.body !== undefined) req.write(options.body);
		req.end();
	});
}

(async () => {
	let token = 'secret-token-1';
	const engine = new QueryEngine(graph, source, { yieldFn: async () => undefined });
	const dispatcher = new McpDispatcher(
		{ name: 'simple-graph-builder', version: '0.7.0' },
		createToolRegistry(engine),
		() => buildInstructions('Test', { notes: 6, entities: 3 })
	);
	const server = new McpHttpServer({ http: http as never, port: 0, token: () => token, dispatcher });
	const port = await server.start();
	check('listens on an ephemeral port', port > 0);

	const auth = () => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });
	const rpc = (message: unknown, headers: Record<string, string> = {}) =>
		request(port, { headers: { ...auth(), ...headers }, body: JSON.stringify(message) });

	// --- happy path ---
	const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
	check('initialize over HTTP', init.status === 200 && JSON.parse(init.body).result.protocolVersion === '2025-06-18', init.body.slice(0, 120));
	check('JSON content type', /application\/json/.test(String(init.headers['content-type'])));
	check('no CORS headers', init.headers['access-control-allow-origin'] === undefined);
	check('no session id minted', init.headers['mcp-session-id'] === undefined);

	const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
	check('notification -> 202 empty', notification.status === 202 && notification.body === '');

	const search = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'transformer secret project' } } });
	check('search over HTTP', search.status === 200 && JSON.parse(search.body).result.structuredContent.notes.length > 0);
	check('excluded note never crosses the wire', !search.body.includes('Private/') && !search.body.includes('Secret Project'));

	const configNote = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_note', arguments: { note: '.obsidian/plugins/x.md', include_content: true } } });
	check('config-dir note refused', JSON.parse(configNote.body).result.isError === true && !configNote.body.includes('transformer config'));

	const allowedOrigin = await rpc({ jsonrpc: '2.0', id: 4, method: 'ping' }, { origin: `http://127.0.0.1:${port}` });
	check('loopback Origin allowed', allowedOrigin.status === 200);

	// --- rejections ---
	const noToken = await request(port, { headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
	check('no token -> 401', noToken.status === 401 && /bearer token/.test(noToken.body));
	const wrongToken = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { authorization: 'Bearer nope' });
	check('wrong token -> 401', wrongToken.status === 401);

	const evilHost = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { host: `evil.example:${port}` });
	check('foreign Host -> 403 (DNS rebinding)', evilHost.status === 403);
	const evilOrigin = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'https://evil.example' });
	check('foreign Origin -> 403', evilOrigin.status === 403);
	const nullOrigin = await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, { origin: 'null' });
	check('opaque Origin -> 403', nullOrigin.status === 403);

	const get = await request(port, { method: 'GET', headers: auth() });
	check('GET -> 405 with Allow: POST', get.status === 405 && get.headers.allow === 'POST');
	const del = await request(port, { method: 'DELETE', headers: auth() });
	check('DELETE -> 405', del.status === 405);
	const options = await request(port, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
	check('CORS preflight refused', options.status === 403 && options.headers['access-control-allow-origin'] === undefined);

	const wrongPath = await request(port, { path: '/other', headers: auth(), body: '{}' });
	check('other paths -> 404', wrongPath.status === 404);

	const textPlain = await request(port, { headers: { ...auth(), 'content-type': 'text/plain' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
	check('non-JSON content type -> 415 (blocks simple cross-site POSTs)', textPlain.status === 415);

	const huge = await request(port, { headers: auth(), body: Buffer.alloc(MAX_BODY_BYTES + 10, 0x20) });
	check('oversized body -> 413', huge.status === 413);

	const garbage = await request(port, { headers: auth(), body: '{not json' });
	check('bad JSON -> 400 / -32700', garbage.status === 400 && JSON.parse(garbage.body).error.code === -32700);

	// --- token rotation takes effect immediately ---
	const oldToken = token;
	token = 'secret-token-2';
	const stale = await request(port, { headers: { 'content-type': 'application/json', authorization: `Bearer ${oldToken}` }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
	check('rotated token: old one rejected', stale.status === 401);
	check('rotated token: new one works', (await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' })).status === 200);

	// --- a second server on the same port fails loudly ---
	const clash = new McpHttpServer({ http: http as never, port, token: () => token, dispatcher });
	let clashCode = '';
	try { await clash.start(); } catch (e: any) { clashCode = e.code; }
	check('port in use is reported', clashCode === 'EADDRINUSE', clashCode);

	// --- client configuration text ---
	const cc = claudeCodeCommand(port, token);
	check('Claude Code command', cc === `claude mcp add --transport http --scope user obsidian-graph http://127.0.0.1:${port}/mcp --header "Authorization: Bearer ${token}"`);
	check('Codex config', codexConfig(port, token).includes(`url = "http://127.0.0.1:${port}/mcp"`) && codexConfig(port, token).includes(`"Authorization" = "Bearer ${token}"`));
	const desktop = JSON.parse(claudeDesktopConfig('node', 'C:\\Vault\\.obsidian\\plugins\\sgb\\mcp-bridge.cjs', port, token));
	check('Claude Desktop config escapes Windows paths', desktop.mcpServers['obsidian-graph'].args[0] === 'C:\\Vault\\.obsidian\\plugins\\sgb\\mcp-bridge.cjs');
	check('Claude Desktop config passes URL and token via env', desktop.mcpServers['obsidian-graph'].env.SGB_MCP_TOKEN === token);

	// --- the stdio bridge ---
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sgb-bridge-'));
	const bridgePath = path.join(dir, 'mcp-bridge.cjs');
	fs.writeFileSync(bridgePath, BRIDGE_SOURCE);

	const runBridge = (env: Record<string, string>, lines: unknown[]) => new Promise<unknown[]>((resolve, reject) => {
		const child = spawn(process.execPath, [bridgePath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
		let out = '';
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', d => { out += d; });
		child.on('error', reject);
		child.on('exit', () => resolve(out.split('\n').filter(Boolean).map(l => JSON.parse(l))));
		for (const line of lines) child.stdin.write(JSON.stringify(line) + '\n');
		child.stdin.end();
	});

	const env = { SGB_MCP_URL: `http://127.0.0.1:${port}/mcp`, SGB_MCP_TOKEN: token };
	const replies = await runBridge(env, [
		{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
		{ jsonrpc: '2.0', method: 'notifications/initialized' },
		{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
		{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_entity', arguments: { entity: 'Transformer' } } },
	]) as any[];
	check('bridge: one reply per request, none for the notification', replies.length === 3, JSON.stringify(replies).slice(0, 200));
	check('bridge: initialize answered', replies.find(r => r.id === 1)?.result?.serverInfo?.name === 'simple-graph-builder');
	check('bridge: tools listed', replies.find(r => r.id === 2)?.result?.tools?.length === 6);
	check('bridge: tool call answered', replies.find(r => r.id === 3)?.result?.structuredContent?.id === 'concept:transformer');

	const modern = await runBridge(env, [{
		jsonrpc: '2.0', id: 9, method: 'tools/call',
		params: { name: 'graph_overview', arguments: {}, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} } },
	}]) as any[];
	check('bridge: mirrors modern headers', modern[0]?.result?.structuredContent?.entities === 3, JSON.stringify(modern[0]).slice(0, 200));

	const badToken = await runBridge({ ...env, SGB_MCP_TOKEN: 'wrong' }, [{ jsonrpc: '2.0', id: 5, method: 'ping' }]) as any[];
	check('bridge: 401 surfaces as an error with the request id', badToken[0]?.id === 5 && /bearer token/.test(badToken[0]?.error?.message));

	// --- stop ---
	await server.stop();
	let refused = false;
	try { await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }); } catch { refused = true; }
	check('stopped server refuses connections', refused);

	const offline = await runBridge(env, [{ jsonrpc: '2.0', id: 7, method: 'ping' }]) as any[];
	check('bridge: says Obsidian is not running', offline[0]?.id === 7 && /Obsidian is not running/.test(offline[0]?.error?.message), JSON.stringify(offline));

	fs.rmSync(dir, { recursive: true, force: true });
	console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
