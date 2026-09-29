/**
 * DeepSeek wire format.
 *
 * DeepSeek speaks OpenAI Chat Completions but only offers JSON mode, not
 * json_schema, and controls reasoning with `thinking` / `reasoning_effort`.
 * These checks pin down exactly what goes over the wire.
 */
import { getAdapter } from '../src/extraction/providers/index';
import { extractOntology, settingsToExtractionOptions } from '../src/extraction/llm-client';
import { DEFAULT_SETTINGS } from '../src/settings';
import { MODEL_OPTIONS } from '../src/extraction/providers/models';
import { EFFORT_LEVELS, EffortLevel } from '../src/extraction/providers/effort';
import { allBodies, captured, resetBodies, setQueue, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const REPLY = JSON.stringify({
  entities: [{ name: 'Ada', entity_type: 'PERSON', description: 'a' }, { name: 'Engine', entity_type: 'TOOL', description: 'b' }],
  relationships: [{ source: 'Ada', target: 'Engine', relationship: 'builds', description: 'c' }],
});
const ok = (content: string, extra: Record<string, unknown> = {}) =>
  ({ status: 200, body: { choices: [{ message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }] } });

const opts = (effort: EffortLevel = 'minimal', maxOutputTokens = 4096) => ({
  provider: 'deepseek' as const, apiKey: 'sk-ds', model: 'deepseek-flash', effort, maxOutputTokens,
});

(async () => {
  check('deepseek-flash is the offered model', MODEL_OPTIONS.deepseek[0] === 'deepseek-flash');
  check('default model is deepseek-flash', DEFAULT_SETTINGS.deepseekModel === 'deepseek-flash');
  const resolved = settingsToExtractionOptions({ ...DEFAULT_SETTINGS, apiProvider: 'deepseek', apiKeys: { deepseek: 'K-D', openai: 'K-O' } });
  check('settings resolve to the DeepSeek key and model', resolved.apiKey === 'K-D' && resolved.model === 'deepseek-flash');

  // --- extraction request shape ---
  setScripted(ok(REPLY));
  const r = await extractOntology(opts(), 'PROMPT');
  const body = captured.body;
  check('POSTs to api.deepseek.com/chat/completions', captured.url === 'https://api.deepseek.com/chat/completions', captured.url);
  check('bearer key', captured.headers.Authorization === 'Bearer sk-ds');
  check('model id passed through', body.model === 'deepseek-flash');
  check('JSON mode, not json_schema', body.response_format?.type === 'json_object', JSON.stringify(body.response_format));
  const system = body.messages.find((m: any) => m.role === 'system')?.content ?? '';
  check('system prompt says JSON (DeepSeek requires the word)', /JSON/.test(system));
  check('system prompt carries the extraction schema', system.includes('"entity_type"') && system.includes('"relationships"'));
  check('the user prompt is untouched', body.messages.at(-1).role === 'user' && body.messages.at(-1).content === 'PROMPT');
  check('extraction parses through', r.nodes.length === 2 && r.relationships.length === 1);

  // --- effort mapping ---
  const sent: Record<string, any> = {};
  for (const level of EFFORT_LEVELS) {
    setScripted(ok(REPLY));
    await extractOntology(opts(level), 'P');
    sent[level] = captured.body;
  }
  check('minimal disables thinking', sent.minimal.thinking?.type === 'disabled' && sent.minimal.reasoning_effort === undefined);
  check('minimal keeps the small token budget', sent.minimal.max_tokens === 4096, String(sent.minimal.max_tokens));
  check('auto sends neither knob', sent.auto.thinking === undefined && sent.auto.reasoning_effort === undefined);
  check('low -> low', sent.low.reasoning_effort === 'low');
  check('medium -> high (no medium level)', sent.medium.reasoning_effort === 'high');
  check('high -> high', sent.high.reasoning_effort === 'high');
  check('max -> max', sent.max.reasoning_effort === 'max');
  check('thinking on raises max_tokens so the answer is not truncated',
    ['auto', 'low', 'medium', 'high', 'max'].every(l => sent[l].max_tokens >= 32768),
    ['auto', 'low', 'max'].map(l => sent[l].max_tokens).join());
  check('a larger budget is kept', await (async () => {
    setScripted(ok(REPLY));
    await extractOntology(opts('high', 65536), 'P');
    return captured.body.max_tokens === 65536;
  })());

  // --- a 400 about thinking drops the effort knobs and retries ---
  resetBodies();
  setQueue([
    { status: 400, body: { error: { message: 'Unknown parameter: thinking' } } },
    ok(REPLY),
  ]);
  await extractOntology(opts('minimal'), 'P');
  check('retried once', allBodies.length === 2, String(allBodies.length));
  check('retry drops thinking', allBodies[1].thinking === undefined);
  check('retry keeps JSON mode', allBodies[1].response_format?.type === 'json_object');

  // --- empty content: DeepSeek documents it happens occasionally ---
  resetBodies();
  setQueue([ok(''), ok(REPLY)]);
  const again = await extractOntology(opts(), 'P');
  check('empty reply is retried once', allBodies.length === 2 && again.nodes.length === 2, String(allBodies.length));

  setQueue([ok(''), ok(''), ok('')]);
  let msg = '';
  try { await extractOntology(opts(), 'P'); } catch (e: any) { msg = e.message; }
  check('two empty replies fail loudly', /Empty response from DeepSeek/.test(msg), msg);

  setScripted({ status: 200, body: { choices: [{ message: { role: 'assistant', content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }] } });
  msg = '';
  try { await extractOntology(opts('high'), 'P'); } catch (e: any) { msg = e.message; }
  check('token-limit cutoff names the cause', /ran out of output tokens/.test(msg), msg);

  // --- missing key ---
  msg = '';
  try {
    await getAdapter('deepseek').complete({ model: 'deepseek-flash', effort: 'auto', maxOutputTokens: 16, turns: [{ kind: 'user', text: 'x' }] }, { apiKey: '' });
  } catch (e: any) { msg = e.message; }
  check('missing key is a config error', /DeepSeek API key not configured/.test(msg), msg);

  // --- tool round trip: reasoning_content must be replayed ---
  const adapter = getAdapter('deepseek');
  const assistant = { role: 'assistant', content: '', reasoning_content: 'I should search.', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"ada"}' } }] };
  setScripted({ status: 200, body: { choices: [{ message: assistant, finish_reason: 'tool_calls' }] } });
  const first = await adapter.complete({ model: 'deepseek-flash', effort: 'high', maxOutputTokens: 512, turns: [{ kind: 'user', text: 'q' }],
    tools: [{ name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } }] }, { apiKey: 'k' });
  check('parses tool calls', first.toolCalls[0]?.name === 'lookup' && (first.toolCalls[0].arguments as any).q === 'ada');

  setScripted(ok('done'));
  await adapter.complete({ model: 'deepseek-flash', effort: 'high', maxOutputTokens: 512, turns: [
    { kind: 'user', text: 'q' },
    { kind: 'assistant', text: '', toolCalls: first.toolCalls, raw: first.raw },
    { kind: 'tool_results', outcomes: [{ id: 'call_1', name: 'lookup', result: { hits: 1 } }] },
  ] }, { apiKey: 'k' });
  const msgs = captured.body.messages;
  check('reasoning_content replayed with the tool call', msgs[1].reasoning_content === 'I should search.');
  check('tool result uses role:tool', msgs[2].role === 'tool' && msgs[2].tool_call_id === 'call_1');
  check('no schema text without a response schema', !msgs.some((m: any) => m.role === 'system'));

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
