/**
 * MCP JSON-RPC dispatch across both protocol eras, and the tool surface.
 *
 * Legacy clients (initialize handshake, 2025-xx revisions) and modern ones
 * (per-request _meta, 2026-07-28) must both work on the same endpoint.
 */
import { McpDispatcher, ErrorCode, decodeHeaderValue } from '../src/mcp/protocol';
import { createToolRegistry, TOOL_DEFINITIONS } from '../src/mcp/tools';
import { buildInstructions } from '../src/mcp/instructions';
import { QueryEngine } from '../src/query/engine';
import { graph, source } from './query-fixture';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const MODERN = '2026-07-28';
const meta = { 'io.modelcontextprotocol/protocolVersion': MODERN, 'io.modelcontextprotocol/clientCapabilities': {} };
const modernHeaders = (method: string, name?: string) => ({
	'mcp-protocol-version': MODERN,
	'mcp-method': method,
	...(name !== undefined ? { 'mcp-name': name } : {}),
});

(async () => {
	const engine = new QueryEngine(graph, source, { yieldFn: async () => undefined });
	const dispatcher = new McpDispatcher(
		{ name: 'simple-graph-builder', title: 'Test vault', version: '0.7.0' },
		createToolRegistry(engine),
		() => buildInstructions('Test', { notes: 6, entities: 3 })
	);
	const body = (r: { body: unknown }) => r.body as any;

	// --- legacy era ---
	const init = await dispatcher.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '1' } } }, {});
	check('initialize: 200', init.status === 200);
	check('initialize: echoes a supported legacy version', body(init).result.protocolVersion === '2025-06-18');
	check('initialize: declares tools', !!body(init).result.capabilities.tools);
	check('initialize: server info', body(init).result.serverInfo.name === 'simple-graph-builder');
	check('initialize: instructions warn about untrusted note text', /not instructions/.test(body(init).result.instructions));
	const future = await dispatcher.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, {});
	check('initialize: unknown version -> latest legacy', body(future).result.protocolVersion === '2025-11-25');

	const note = await dispatcher.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, {});
	check('notification -> 202, no body', note.status === 202 && note.body === null);

	const list = await dispatcher.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { 'mcp-protocol-version': '2025-06-18' });
	const tools = body(list).result.tools as { name: string; annotations: any; inputSchema: any }[];
	check('tools/list: six tools', tools.length === 6, tools.map(t => t.name).join());
	check('tools/list: all read-only', tools.every(t => t.annotations?.readOnlyHint === true));
	check('tools/list: object input schemas', tools.every(t => t.inputSchema.type === 'object'));
	check('tools/list: deterministic order', JSON.stringify(tools.map(t => t.name)) === JSON.stringify(TOOL_DEFINITIONS.map(t => t.name)));

	const call = await dispatcher.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'search', arguments: { query: 'transformer', limit: 3 } } }, {});
	const result = body(call).result;
	check('tools/call: text content', result.content[0].type === 'text' && JSON.parse(result.content[0].text).notes.length > 0);
	check('tools/call: structuredContent is an object', typeof result.structuredContent === 'object' && !Array.isArray(result.structuredContent));
	check('tools/call: excluded note never served', !result.content[0].text.includes('Private/'));
	check('tools/call: resultType complete', result.resultType === 'complete');

	const missing = await dispatcher.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_entity', arguments: { entity: 'Secret Project' } } }, {});
	check('not found is a tool error the model can see', body(missing).result.isError === true && /No visible entity/.test(body(missing).result.content[0].text));

	const badArg = await dispatcher.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'search', arguments: { query: 42 } } }, {});
	check('wrong argument type is a tool error', body(badArg).result.isError === true && /must be a string/.test(body(badArg).result.content[0].text));

	const unknownTool = await dispatcher.handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } }, {});
	check('unknown tool is -32602', body(unknownTool).error?.code === ErrorCode.InvalidParams);

	const unknownMethod = await dispatcher.handle({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, {});
	check('legacy unknown method: JSON-RPC -32601', body(unknownMethod).error?.code === ErrorCode.MethodNotFound);

	const badLegacyHeader = await dispatcher.handle({ jsonrpc: '2.0', id: 9, method: 'ping' }, { 'mcp-protocol-version': '1999-01-01' });
	check('unsupported legacy header -> 400', badLegacyHeader.status === 400);

	const proto = await dispatcher.handle({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'get_note', arguments: { note: '__proto__' } } }, {});
	check('prototype names are not tools or crashes', proto.status === 200);
	const protoTool = await dispatcher.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'constructor', arguments: {} } }, {});
	check('"constructor" is not a tool', body(protoTool).error?.code === ErrorCode.InvalidParams);

	// --- modern era ---
	const discover = await dispatcher.handle({ jsonrpc: '2.0', id: 20, method: 'server/discover', params: { _meta: meta } }, modernHeaders('server/discover'));
	check('discover: 200', discover.status === 200, JSON.stringify(discover.body));
	check('discover: lists both eras', body(discover).result.supportedVersions.includes(MODERN) && body(discover).result.supportedVersions.includes('2025-06-18'));
	check('discover: serverInfo in _meta', body(discover).result._meta['io.modelcontextprotocol/serverInfo'].name === 'simple-graph-builder');
	check('discover: instructions', typeof body(discover).result.instructions === 'string');

	const mcall = await dispatcher.handle(
		{ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'graph_overview', arguments: {}, _meta: meta } },
		modernHeaders('tools/call', 'graph_overview'));
	check('modern tools/call works', mcall.status === 200 && body(mcall).result.structuredContent.entities === 3, JSON.stringify(mcall.body).slice(0, 200));

	const wrongVersion = await dispatcher.handle(
		{ jsonrpc: '2.0', id: 22, method: 'ping', params: { _meta: { ...meta, 'io.modelcontextprotocol/protocolVersion': '2099-01-01' } } },
		{ 'mcp-protocol-version': '2099-01-01', 'mcp-method': 'ping' });
	check('unsupported version -> 400 / -32022', wrongVersion.status === 400 && body(wrongVersion).error.code === ErrorCode.UnsupportedProtocolVersion);
	check('...listing supported versions', body(wrongVersion).error.data.supported.includes(MODERN));

	const headerMismatch = await dispatcher.handle(
		{ jsonrpc: '2.0', id: 23, method: 'tools/call', params: { name: 'search', arguments: { query: 'x' }, _meta: meta } },
		modernHeaders('tools/call', 'get_note'));
	check('Mcp-Name mismatch -> 400 / -32020', headerMismatch.status === 400 && body(headerMismatch).error.code === ErrorCode.HeaderMismatch);

	const methodMismatch = await dispatcher.handle({ jsonrpc: '2.0', id: 24, method: 'tools/list', params: { _meta: meta } }, modernHeaders('ping'));
	check('Mcp-Method mismatch -> -32020', body(methodMismatch).error?.code === ErrorCode.HeaderMismatch);

	const noHeader = await dispatcher.handle({ jsonrpc: '2.0', id: 25, method: 'tools/list', params: { _meta: meta } }, {});
	check('missing version header -> -32020', noHeader.status === 400 && body(noHeader).error.code === ErrorCode.HeaderMismatch);

	const noCaps = await dispatcher.handle(
		{ jsonrpc: '2.0', id: 26, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } },
		modernHeaders('tools/list'));
	check('missing clientCapabilities -> 400 / -32602', noCaps.status === 400 && body(noCaps).error.code === ErrorCode.InvalidParams);

	const encodedName = `=?base64?${Buffer.from('graph_overview').toString('base64')}?=`;
	const b64 = await dispatcher.handle(
		{ jsonrpc: '2.0', id: 27, method: 'tools/call', params: { name: 'graph_overview', arguments: {}, _meta: meta } },
		modernHeaders('tools/call', encodedName));
	check('base64 Mcp-Name is decoded', b64.status === 200, JSON.stringify(b64.body).slice(0, 200));
	check('decodes UTF-8 base64', decodeHeaderValue(`=?base64?${Buffer.from('Hello, 世界').toString('base64')}?=`) === 'Hello, 世界');
	check('plain header values pass through', decodeHeaderValue('search') === 'search');

	const modernUnknown = await dispatcher.handle({ jsonrpc: '2.0', id: 28, method: 'resources/list', params: { _meta: meta } }, modernHeaders('resources/list'));
	check('modern unknown method -> 404 / -32601', modernUnknown.status === 404 && body(modernUnknown).error.code === ErrorCode.MethodNotFound);

	const mresult = body(mcall).result;
	check('modern results carry resultType and serverInfo', mresult.resultType === 'complete' && !!mresult._meta?.['io.modelcontextprotocol/serverInfo']);

	// --- malformed input ---
	check('batch rejected', (await dispatcher.handle([{ jsonrpc: '2.0', id: 1, method: 'ping' }], {})).status === 400);
	check('non-JSON-RPC rejected', (await dispatcher.handle({ hello: 'world' }, {})).status === 400);
	check('null id rejected', (await dispatcher.handle({ jsonrpc: '2.0', id: null, method: 'ping' }, {})).status === 400);

	// --- each tool end to end ---
	const callTool = async (name: string, args: Record<string, unknown>) =>
		body(await dispatcher.handle({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name, arguments: args } }, {})).result;
	check('get_entity', (await callTool('get_entity', { entity: 'Transformer' })).structuredContent.id === 'concept:transformer');
	check('get_note with content', /relies on attention/.test((await callTool('get_note', { note: 'AI/Transformer.md', include_content: true })).structuredContent.content));
	check('get_note refuses config dir', (await callTool('get_note', { note: '.obsidian/plugins/x.md' })).isError === true);
	check('neighbors', (await callTool('neighbors', { entity: 'Transformer' })).structuredContent.neighbors[0].id === 'concept:attention');
	check('find_path', (await callTool('find_path', { from: 'Attention', to: 'Transformer' })).structuredContent.found === true);
	check('search entities mode', (await callTool('search', { query: 'attention', mode: 'entities' })).structuredContent.notes.length === 0);
	check('bad enum is a tool error', (await callTool('search', { query: 'x', mode: 'everything' })).isError === true);

	console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
