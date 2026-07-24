import { getSmartSearchTools, buildSmartSearchSystemPrompt } from '../src/extraction/prompts';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const tools = getSmartSearchTools();
const names = tools.map(t => t.name);

// Every tool the dispatcher implements must be advertised, or the LLM cannot reach it.
const DISPATCHED = ['search_nodes', 'get_node', 'get_relationships', 'get_connected_nodes', 'get_source_notes', 'find_path'];
for (const n of DISPATCHED) check(`${n} is exposed to the model`, names.includes(n), names.join(','));
check('no extra tools beyond the dispatcher', names.every(n => DISPATCHED.includes(n)), names.join(','));

const fp = tools.find(t => t.name === 'find_path')!;
check('find_path params match the dispatcher arg names',
  'from_name' in (fp.parameters.properties as any) && 'to_name' in (fp.parameters.properties as any) && 'max_hops' in (fp.parameters.properties as any),
  Object.keys(fp.parameters.properties as any).join(','));
check('find_path requires both endpoints', JSON.stringify(fp.parameters.required) === '["from_name","to_name"]');

const prompt = buildSmartSearchSystemPrompt();
for (const n of DISPATCHED) check(`system prompt documents ${n}`, prompt.includes(n));

// Schemas must be well-formed for every provider's tool format
for (const t of tools) {
  check(`${t.name}: has description`, typeof t.description === 'string' && t.description.length > 10);
  check(`${t.name}: params are an object schema`, (t.parameters as any).type === 'object');
  const props = Object.keys((t.parameters as any).properties ?? {});
  const req: string[] = (t.parameters as any).required ?? [];
  check(`${t.name}: required fields all exist in properties`, req.every(r => props.includes(r)), `${req} vs ${props}`);
}

console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
process.exit(fail ? 1 : 0);
