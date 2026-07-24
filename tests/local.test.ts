import { getAdapter } from '../src/extraction/providers/index';
import { extractOntology } from '../src/extraction/llm-client';
import { captured, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const HOST = 'http://100.22.169.13:8091';
const REPLY = JSON.stringify({
  entities: [{ name: 'Ada', entity_type: 'PERSON', description: '' }, { name: 'Engine', entity_type: 'TOOL', description: '' }],
  relationships: [{ source: 'Ada', target: 'Engine', relationship: 'builds', description: '' }],
});
const chat = (msg: unknown) => setScripted({ status: 200, body: { choices: [{ message: msg, finish_reason: 'stop' }] } });

(async () => {
  // routing
  check('ollama style -> native adapter', getAdapter('ollama', { apiKey: '', localApiStyle: 'ollama' }).capabilities('x') !== undefined);
  const a1 = getAdapter('ollama', { apiKey: '', ollamaHost: HOST, localApiStyle: 'openai' });
  const a2 = getAdapter('ollama', { apiKey: '', ollamaHost: HOST, localApiStyle: 'ollama' });
  check('openai style selects a DIFFERENT adapter', a1 !== a2);
  check('cloud providers ignore localApiStyle', getAdapter('claude', { apiKey: 'k', localApiStyle: 'openai' }) === getAdapter('claude'));

  const opts = { provider: 'ollama' as const, apiKey: '', model: 'qwen3-8b', effort: 'minimal' as const, maxOutputTokens: 4096, ollamaHost: HOST, localApiStyle: 'openai' as const };

  chat({ role: 'assistant', content: REPLY });
  const r = await extractOntology(opts, 'PROMPT');
  check('hits /v1/chat/completions on the configured host', captured.url === `${HOST}/v1/chat/completions`, captured.url);
  check('NOT /api/chat (would 404 on llama-server)', !captured.url!.includes('/api/chat'));
  check('no Authorization header when no key set', captured.headers.Authorization === undefined);
  check('sends max_tokens', captured.body.max_tokens === 4096);
  check('sends response_format json_schema', captured.body.response_format?.type === 'json_schema');
  check('schema nested under json_schema.schema (OpenAI shape)', captured.body.response_format?.json_schema?.schema?.type === 'object');
  check('schema has no additionalProperties (local servers reject it)', !JSON.stringify(captured.body.response_format).includes('additionalProperties'));
  check('minimal -> reasoning_effort none', captured.body.reasoning_effort === 'none');
  check('extraction parses through', r.nodes.length === 2 && r.relationships.length === 1);

  // /v1 not doubled if the host already includes it
  chat({ role: 'assistant', content: REPLY });
  await extractOntology({ ...opts, ollamaHost: `${HOST}/v1` }, 'PROMPT');
  check('does not double the /v1 prefix', captured.url === `${HOST}/v1/chat/completions`, captured.url);

  // trailing slash
  chat({ role: 'assistant', content: REPLY });
  await extractOntology({ ...opts, ollamaHost: `${HOST}/` }, 'PROMPT');
  check('trailing slash normalised', captured.url === `${HOST}/v1/chat/completions`, captured.url);

  // api key when the server was started with --api-key
  chat({ role: 'assistant', content: REPLY });
  await extractOntology({ ...opts, apiKey: 'sk-local' }, 'PROMPT');
  check('sends bearer token when a key is configured', captured.headers.Authorization === 'Bearer sk-local');

  // tool calling round trip
  const { runToolLoop } = await import('../src/extraction/providers/tool-loop');
  let turn = 0;
  const adapter = getAdapter('ollama', { apiKey: '', ollamaHost: HOST, localApiStyle: 'openai' });
  setScripted({ status: 200, body: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_nodes', arguments: '{"query":"ada"}' } }] } }] } });
  const first = await adapter.complete({ model: 'm', effort: 'auto', maxOutputTokens: 512, turns: [{ kind: 'user', text: 'q' }] }, { apiKey: '', ollamaHost: HOST, localApiStyle: 'openai' });
  check('parses OpenAI-style tool_calls', first.toolCalls.length === 1 && first.toolCalls[0].name === 'search_nodes');
  check('parses stringified arguments', (first.toolCalls[0].arguments as any).query === 'ada');

  await adapter.complete({ model: 'm', effort: 'auto', maxOutputTokens: 512, turns: [
    { kind: 'user', text: 'q' },
    { kind: 'assistant', text: '', toolCalls: first.toolCalls, raw: { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_nodes', arguments: '{}' } }] } },
    { kind: 'tool_results', outcomes: [{ id: 'call_1', name: 'search_nodes', result: { hits: 1 } }] },
  ] }, { apiKey: '', ollamaHost: HOST, localApiStyle: 'openai' });
  const msgs = captured.body.messages;
  check('assistant turn replays tool_calls', Array.isArray(msgs[1].tool_calls));
  check('tool result uses role:tool + tool_call_id', msgs[2].role === 'tool' && msgs[2].tool_call_id === 'call_1');

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
