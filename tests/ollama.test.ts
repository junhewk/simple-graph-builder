import { ollamaAdapter } from '../src/extraction/providers/ollama';
import { anthropicAdapter } from '../src/extraction/providers/anthropic';
import { captured, allBodies, setScripted, setQueue, resetBodies } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const creds = { apiKey: '', ollamaHost: 'http://localhost:11434/' };
const base = { model: 'qwen3:8b', maxOutputTokens: 4096 };

(async () => {
  setScripted({ status: 200, body: { message: { role: 'assistant', content: 'hi' }, done_reason: 'stop' } });

  await ollamaAdapter.complete({ ...base, effort: 'minimal', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('uses /api/chat not /api/generate', captured.url === 'http://localhost:11434/api/chat');
  check('trailing slash in host normalised', !captured.url!.includes('//api'));
  check('minimal -> think:false', captured.body.think === false);
  check('stream false', captured.body.stream === false);

  await ollamaAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('auto -> no think field', captured.body.think === undefined);

  await ollamaAdapter.complete({ ...base, effort: 'high', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('high -> think:"high"', captured.body.think === 'high');

  await ollamaAdapter.complete({ ...base, effort: 'auto', system: 'SYS', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('system becomes a system message', captured.body.messages[0].role === 'system' && captured.body.messages[0].content === 'SYS');

  await ollamaAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }], responseSchema: { name: 'o', schema: { type: 'object' } } }, creds);
  check('responseSchema -> format', JSON.stringify(captured.body.format) === '{"type":"object"}');

  // THE regression: tool_calls must survive the round trip
  await ollamaAdapter.complete({
    ...base, effort: 'auto',
    turns: [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: '', toolCalls: [{ id: 'search_nodes_0', name: 'search_nodes', arguments: {} }],
        raw: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'search_nodes', arguments: {} } }] } },
      { kind: 'tool_results', outcomes: [{ id: 'search_nodes_0', name: 'search_nodes', result: { hits: 2 } }] },
    ],
  }, creds);
  const m = captured.body.messages;
  check('assistant turn keeps tool_calls (the old bug)', Array.isArray(m[1].tool_calls) && m[1].tool_calls.length === 1);
  check('tool result uses role:tool', m[2].role === 'tool');
  check('tool result carries tool_name', m[2].tool_name === 'search_nodes');
  check('tool result content is serialised', m[2].content === '{"hits":2}');

  // Ollama assigns no call ids -> adapter must synthesise them
  setScripted({ status: 200, body: { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_node', arguments: { name: 'X' } } }] } } });
  const r = await ollamaAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('synthesises a tool call id', r.toolCalls[0].id === 'get_node_0');
  check('object arguments passed through', (r.toolCalls[0].arguments as any).name === 'X');
  check('empty content + tool call is not an error', r.text === '' && r.toolCalls.length === 1);

  // ---- downgrade retry ----
  resetBodies();
  setQueue([
    { status: 400, body: { error: 'unknown field "think" for this model' } },
    { status: 200, body: { message: { role: 'assistant', content: 'ok' } } },
  ]);
  const r2 = await ollamaAdapter.complete({ ...base, effort: 'high', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('downgrade: recovers after think rejected', r2.text === 'ok');
  check('downgrade: first attempt had think', allBodies[0].think === 'high');
  check('downgrade: retry dropped think', allBodies[1].think === undefined);

  resetBodies();
  setQueue([
    { status: 400, body: { error: 'response_format schema not supported' } },
    { status: 200, body: { message: { role: 'assistant', content: 'ok' } } },
  ]);
  let schemaErr = '';
  try {
    await ollamaAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }], responseSchema: { name: 'o', schema: { type: 'object' } } }, creds);
  } catch (e: any) { schemaErr = e.message; }
  check('schema rejection FAILS, never silently degrades', /requires a model that supports JSON schema/.test(schemaErr), schemaErr);
  check('schema rejection does not retry', allBodies.length === 1, `attempts=${allBodies.length}`);

  // A 400 that is not about effort/schema must NOT be retried
  resetBodies();
  setQueue([{ status: 400, body: { error: 'model "nope" not found' } }]);
  let threw = false;
  try { await ollamaAdapter.complete({ ...base, model: 'nope', effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds); }
  catch { threw = true; }
  check('unrelated 400 propagates without retry', threw && allBodies.length === 1);

  // 401 must not be retried either (anthropic path)
  resetBodies();
  setQueue([{ status: 401, body: { error: { type: 'authentication_error', message: 'bad key' } } }]);
  let msg = '';
  try { await anthropicAdapter.complete({ model: 'claude-sonnet-5', effort: 'high', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, { apiKey: 'bad' }); }
  catch (e: any) { msg = e.message; }
  check('401 surfaces as an API-key error, no retry', /Invalid claude API key/.test(msg) && allBodies.length === 1, msg);

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
