import { anthropicAdapter } from '../src/extraction/providers/anthropic';
import { openaiAdapter } from '../src/extraction/providers/openai';
import { captured, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const creds = { apiKey: 'sk-test' };

(async () => {
  // ---- Anthropic ----
  setScripted({ status: 200, body: { content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' } });

  await anthropicAdapter.complete({ model: 'claude-sonnet-5', effort: 'minimal', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('anthropic endpoint', captured.url === 'https://api.anthropic.com/v1/messages');
  check('anthropic version header', captured.headers['anthropic-version'] === '2023-06-01');
  check('sonnet5+minimal -> thinking disabled', JSON.stringify(captured.body.thinking) === '{"type":"disabled"}');
  check('sonnet5+minimal -> no effort', captured.body.output_config === undefined);
  check('no temperature ever', captured.body.temperature === undefined);
  check('max_tokens present', captured.body.max_tokens === 4096);

  await anthropicAdapter.complete({ model: 'claude-sonnet-5', effort: 'high', maxOutputTokens: 16384, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('sonnet5+high -> adaptive', JSON.stringify(captured.body.thinking) === '{"type":"adaptive"}');
  check('sonnet5+high -> effort high', captured.body.output_config?.effort === 'high');

  await anthropicAdapter.complete({ model: 'claude-haiku-4-5', effort: 'high', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('haiku4.5 -> NO thinking (would 400)', captured.body.thinking === undefined);
  check('haiku4.5 -> NO output_config.effort (would 400)', captured.body.output_config?.effort === undefined);

  await anthropicAdapter.complete({ model: 'custom-proxy-model', effort: 'max', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('unknown model -> no optional params', captured.body.thinking === undefined && captured.body.output_config === undefined);

  await anthropicAdapter.complete({
    model: 'claude-sonnet-5', effort: 'auto', maxOutputTokens: 4096,
    turns: [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: '', toolCalls: [{ id: 't1', name: 'f', arguments: {} }], raw: [{ type: 'thinking', thinking: 'x' }, { type: 'tool_use', id: 't1', name: 'f', input: {} }] },
      { kind: 'tool_results', outcomes: [{ id: 't1', name: 'f', result: { ok: 1 } }, { id: 't2', name: 'g', result: 'bad', isError: true }] },
    ],
  }, creds);
  check('auto -> no thinking field', captured.body.thinking === undefined);
  const m = captured.body.messages;
  check('assistant replays native blocks (thinking preserved)', m[1].content[0].type === 'thinking');
  check('all tool_results in ONE user message', m.length === 3 && m[2].role === 'user' && m[2].content.length === 2);
  check('tool_result uses tool_use_id', m[2].content[0].tool_use_id === 't1');
  check('is_error flagged', m[2].content[1].is_error === true);

  // structured output
  await anthropicAdapter.complete({ model: 'claude-sonnet-5', effort: 'auto', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }], responseSchema: { name: 'o', schema: { type: 'object' } } }, creds);
  check('anthropic structured output shape', captured.body.output_config?.format?.type === 'json_schema');

  // leading thinking block must not break text extraction
  setScripted({ status: 200, body: { content: [{ type: 'thinking', thinking: 'zzz' }, { type: 'text', text: 'real' }], stop_reason: 'end_turn' } });
  const r = await anthropicAdapter.complete({ model: 'claude-sonnet-5', effort: 'auto', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('text extracted past leading thinking block', r.text === 'real');

  // ---- OpenAI ----
  setScripted({ status: 200, body: { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'yo' }] }], status: 'completed' } });

  await openaiAdapter.complete({ model: 'gpt-5.6-luna', effort: 'minimal', maxOutputTokens: 4096, system: 'SYS', turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('openai endpoint is /v1/responses', captured.url === 'https://api.openai.com/v1/responses');
  check('openai no temperature', captured.body.temperature === undefined);
  check('openai no max_tokens (uses max_output_tokens)', captured.body.max_tokens === undefined && captured.body.max_output_tokens === 4096);
  check('minimal -> reasoning.effort none', captured.body.reasoning?.effort === 'none');
  check('system -> instructions', captured.body.instructions === 'SYS');
  check('store:false', captured.body.store === false);

  await openaiAdapter.complete({ model: 'gpt-5.6-luna', effort: 'max', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('max -> xhigh', captured.body.reasoning?.effort === 'xhigh');

  await openaiAdapter.complete({ model: 'gpt-5.6-luna', effort: 'auto', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('auto -> no reasoning field', captured.body.reasoning === undefined);

  await openaiAdapter.complete({
    model: 'gpt-5.6-luna', effort: 'auto', maxOutputTokens: 4096,
    tools: [{ name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [] } }],
    turns: [
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'f', arguments: {} }], raw: [{ type: 'reasoning', id: 'rs_1' }, { type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{}' }] },
      { kind: 'tool_results', outcomes: [{ id: 'call_1', name: 'f', result: { ok: 1 } }] },
    ],
  }, creds);
  check('openai tools are FLAT (no nested function{})', captured.body.tools[0].type === 'function' && captured.body.tools[0].name === 'f' && captured.body.tools[0].function === undefined);
  check('tools not strict (schemas have optional params)', captured.body.tools[0].strict === false);
  const inp = captured.body.input;
  check('assistant raw spread into input (reasoning replayed)', inp[1].type === 'reasoning' && inp[2].type === 'function_call');
  check('tool result is function_call_output w/ call_id', inp[3].type === 'function_call_output' && inp[3].call_id === 'call_1');

  const r2 = await openaiAdapter.complete({ model: 'gpt-5.6-luna', effort: 'auto', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('openai text read from output_text block', r2.text === 'yo');

  // function_call arguments arrive as a JSON string and must be parsed
  setScripted({ status: 200, body: { output: [{ type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"query":"x"}' }] } });
  const r3 = await openaiAdapter.complete({ model: 'gpt-5.6-luna', effort: 'auto', maxOutputTokens: 4096, turns: [{ kind: 'user', text: 'q' }] }, creds);
  check('openai args parsed from JSON string', (r3.toolCalls[0].arguments as any).query === 'x');
  check('empty text + toolCalls is not an error', r3.text === '' && r3.toolCalls.length === 1);

  // structured output is required: a model that cannot do it must error, not silently omit
  let noSchemaErr = '';
  try {
    await anthropicAdapter.complete({ model: 'claude-sonnet-4-5-20250929', effort: 'auto', maxOutputTokens: 4096,
      turns: [{ kind: 'user', text: 'q' }], responseSchema: { name: 'o', schema: { type: 'object' } } }, creds);
  } catch (e: any) { noSchemaErr = e.message; }
  check('unsupported model + schema -> hard error, not silent omission', /does not support structured output/.test(noSchemaErr), noSchemaErr);

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
