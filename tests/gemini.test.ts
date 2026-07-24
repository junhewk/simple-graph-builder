import { geminiAdapter } from '../src/extraction/providers/gemini';
import { captured, allBodies, setScripted, setQueue, resetBodies } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const creds = { apiKey: 'AIza-test' };
const base = { model: 'gemini-3.6-flash', maxOutputTokens: 8192 };

(async () => {
  setScripted({ status: 200, body: { status: 'completed', steps: [{ type: 'thought', signature: 'sig' }, { type: 'model_output', content: [{ type: 'text', text: 'hello' }] }] } });

  const r = await geminiAdapter.complete({ ...base, effort: 'minimal', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('uses /v1beta/interactions', captured.url === 'https://generativelanguage.googleapis.com/v1beta/interactions');
  check('api key in header, not URL', captured.headers['x-goog-api-key'] === 'AIza-test' && !captured.url!.includes('key='));
  check('no temperature', captured.body.temperature === undefined && captured.body.generation_config.temperature === undefined);
  check('no candidate_count', captured.body.candidate_count === undefined);
  check('no legacy contents field', captured.body.contents === undefined);
  check('store:false (history stays local)', captured.body.store === false);
  check('max_output_tokens inside generation_config', captured.body.generation_config.max_output_tokens === 8192);
  check('minimal -> thinking_level minimal', captured.body.generation_config.thinking_level === 'minimal');
  check('user turn is user_input shape', captured.body.input[0].type === 'user_input' && captured.body.input[0].content[0].text === 'q');
  check('text read from model_output steps', r.text === 'hello');
  check('raw keeps thought step for replay', Array.isArray(r.raw) && (r.raw as any[]).some(s => s.type === 'thought'));

  await geminiAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('auto -> no thinking_level', captured.body.generation_config.thinking_level === undefined);

  await geminiAdapter.complete({ ...base, effort: 'max', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('max clamps to high (enum tops out)', captured.body.generation_config.thinking_level === 'high');

  await geminiAdapter.complete({ ...base, effort: 'auto', system: 'SYS', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('system_instruction top-level', captured.body.system_instruction === 'SYS');

  await geminiAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }],
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }] }, creds);
  check('tools are flat {type:function,name,...}', captured.body.tools[0].type === 'function' && captured.body.tools[0].name === 'f');
  check('no functionDeclarations wrapper', captured.body.tools[0].functionDeclarations === undefined);

  // multi-turn: model steps must be echoed verbatim
  await geminiAdapter.complete({
    ...base, effort: 'auto',
    turns: [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: '', toolCalls: [{ id: 'call_abc', name: 'search_nodes', arguments: { query: 'x' } }],
        raw: [{ type: 'thought', signature: 'EvEFCu4F' }, { type: 'function_call', id: 'call_abc', name: 'search_nodes', arguments: { query: 'x' } }] },
      { kind: 'tool_results', outcomes: [{ id: 'call_abc', name: 'search_nodes', result: { hits: 3 } }] },
    ],
  }, creds);
  const inp = captured.body.input;
  check('thought step replayed verbatim (signature intact)', inp[1].type === 'thought' && inp[1].signature === 'EvEFCu4F');
  check('function_call step replayed', inp[2].type === 'function_call' && inp[2].id === 'call_abc');
  check('result is function_result with call_id', inp[3].type === 'function_result' && inp[3].call_id === 'call_abc');
  check('function_result carries name', inp[3].name === 'search_nodes');
  check('function_result.result is a content array', Array.isArray(inp[3].result) && inp[3].result[0].type === 'text');

  // function_call arguments arrive as an OBJECT, unlike OpenAI's JSON string
  setScripted({ status: 200, body: { status: 'requires_action', steps: [{ type: 'function_call', id: 'c1', name: 'get_node', arguments: { name: 'Ada' } }] } });
  const r2 = await geminiAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('args used as object, not re-parsed', (r2.toolCalls[0].arguments as any).name === 'Ada');
  check('empty text + tool call is not an error', r2.text === '' && r2.toolCalls.length === 1);
  check('raw excludes non-model steps', (r2.raw as any[]).every(s => ['thought','model_output','function_call'].includes(s.type)));

  // HTTP 200 carrying an error body
  setScripted({ status: 200, body: { error: { message: 'quota exceeded' } } });
  let msg = '';
  try { await geminiAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }] }, creds); }
  catch (e: any) { msg = e.message; }
  check('error body on HTTP 200 still throws', /quota exceeded/.test(msg), msg);

  // structured output is required -- a rejection must surface, not degrade
  resetBodies();
  setQueue([
    { status: 400, body: { error: { message: 'Invalid JSON payload received. Unknown name "response_format".' } } },
    { status: 200, body: { steps: [{ type: 'model_output', content: [{ type: 'text', text: '{}' }] }] } },
  ]);
  let schemaErr = '';
  try {
    await geminiAdapter.complete({ ...base, effort: 'auto', turns: [{ kind: 'user', text: 'q' }], responseSchema: { name: 'o', schema: { type: 'object' } } }, creds);
  } catch (e: any) { schemaErr = e.message; }
  check('gemini schema rejection FAILS loudly', /requires a model that supports JSON schema/.test(schemaErr), schemaErr);
  check('gemini schema rejection does not retry', allBodies.length === 1, `attempts=${allBodies.length}`);

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
