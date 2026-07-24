import { runToolLoop } from '../src/extraction/providers/tool-loop';
import { LlmRequest, LlmResult, ProviderAdapter, Turn } from '../src/extraction/providers/types';

let fail = 0;
const check = (name: string, cond: boolean, extra = '') => {
  if (!cond) fail++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${extra ? ' :: ' + extra : ''}`);
};

function fakeAdapter(script: LlmResult[]): { adapter: ProviderAdapter; seen: Turn[][] } {
  const seen: Turn[][] = [];
  let i = 0;
  const adapter: ProviderAdapter = {
    id: 'claude',
    capabilities: () => ({ tools: true, structuredOutput: true, effort: true }),
    async complete(req: LlmRequest): Promise<LlmResult> {
      seen.push(JSON.parse(JSON.stringify(req.turns)));
      return script[Math.min(i++, script.length - 1)];
    },
  };
  return { adapter, seen };
}

const base = { model: 'm', effort: 'minimal' as const, maxOutputTokens: 4096 };

(async () => {
  // 1. Terminates immediately with no tool calls
  {
    const { adapter, seen } = fakeAdapter([{ text: 'done', toolCalls: [], raw: [] }]);
    const r = await runToolLoop({ adapter, request: base, creds: { apiKey: 'k' }, initialUserText: 'q', execute: () => 'x' });
    check('no-tools returns text', r.text === 'done' && r.iterations === 1 && !r.exhausted);
    check('first request has exactly the user turn', seen[0].length === 1 && seen[0][0].kind === 'user');
  }

  // 2. One tool round-trip threads turns correctly
  {
    const { adapter, seen } = fakeAdapter([
      { text: '', toolCalls: [{ id: 'c1', name: 'search_nodes', arguments: { query: 'a' } }], raw: [{ nativeBlock: true }] },
      { text: 'answer', toolCalls: [], raw: [] },
    ]);
    const executed: string[] = [];
    const r = await runToolLoop({
      adapter, request: base, creds: { apiKey: 'k' }, initialUserText: 'q',
      execute: (c) => { executed.push(c.name); return { hit: 1 }; },
    });
    check('tool round-trip returns final text', r.text === 'answer' && r.iterations === 2);
    check('tool was executed', executed.length === 1 && executed[0] === 'search_nodes');
    const t = seen[1];
    check('second request has 3 turns', t.length === 3, `got ${t.length}`);
    check('turn[1] is assistant carrying raw', t[1].kind === 'assistant' && JSON.stringify((t[1] as any).raw) === '[{"nativeBlock":true}]');
    check('turn[2] is tool_results with matching id', t[2].kind === 'tool_results' && (t[2] as any).outcomes[0].id === 'c1');
    check('empty text + toolCalls did not terminate the loop', r.iterations === 2);
  }

  // 3. Tool failure becomes an isError outcome, loop continues
  {
    const { adapter, seen } = fakeAdapter([
      { text: '', toolCalls: [{ id: 'c9', name: 'boom', arguments: {} }], raw: [] },
      { text: 'recovered', toolCalls: [], raw: [] },
    ]);
    const r = await runToolLoop({
      adapter, request: base, creds: { apiKey: 'k' }, initialUserText: 'q',
      execute: () => { throw new Error('kaboom'); },
    });
    const outcomes = (seen[1][2] as any).outcomes;
    check('tool error is reported back, not dropped', outcomes.length === 1 && outcomes[0].isError === true);
    check('error text preserved', JSON.stringify(outcomes[0].result).includes('kaboom'));
    check('loop recovers', r.text === 'recovered');
  }

  // 4. Cap is respected
  {
    const { adapter } = fakeAdapter([{ text: '', toolCalls: [{ id: 'x', name: 'n', arguments: {} }], raw: [] }]);
    const r = await runToolLoop({ adapter, request: base, creds: { apiKey: 'k' }, initialUserText: 'q', execute: () => 'x', maxIterations: 4 });
    check('exhausted after cap', r.exhausted === true && r.iterations === 4);
  }

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
