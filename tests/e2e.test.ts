import { extractOntology } from '../src/extraction/llm-client';
import { captured, allBodies, setScripted, resetBodies } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

// Exactly what a schema-conformant model returns.
const SCHEMA_REPLY = JSON.stringify({
  entities: [
    { name: 'Ada Lovelace', entity_type: 'PERSON', description: 'Mathematician' },
    { name: 'Analytical Engine', entity_type: 'TOOL', description: '' },
  ],
  relationships: [
    { source: 'Ada Lovelace', target: 'Analytical Engine', relationship: 'works on', description: '' },
  ],
});

const opts = { apiKey: 'k', model: 'claude-sonnet-5', effort: 'minimal' as const, maxOutputTokens: 4096 };

(async () => {
  // --- Anthropic: schema goes out, result parses ---
  setScripted({ status: 200, body: { content: [{ type: 'text', text: SCHEMA_REPLY }] } });
  const r = await extractOntology({ ...opts, provider: 'claude' }, 'PROMPT');
  check('anthropic sends output_config.format', captured.body.output_config?.format?.type === 'json_schema');
  check('schema has the entity enum', JSON.stringify(captured.body.output_config.format.schema).includes('ORGANIZATION'));
  check('2 nodes parsed', r.nodes.length === 2, `got ${r.nodes.length}`);
  check('entity types preserved', r.nodes[0].entityType === 'PERSON' && r.nodes[1].entityType === 'TOOL');
  check('names preserved', r.nodes[0].properties.name === 'Ada Lovelace');
  check('relationship resolved by NAME to node ids', r.relationships.length === 1 &&
    r.relationships[0].source === r.nodes[0].id && r.relationships[0].target === r.nodes[1].id,
    JSON.stringify(r.relationships));
  check('empty description stored as undefined, not ""', r.nodes[1].properties.description === undefined);

  // --- Gemini: additionalProperties must not be sent ---
  setScripted({ status: 200, body: { steps: [{ type: 'model_output', content: [{ type: 'text', text: SCHEMA_REPLY }] }] } });
  const rg = await extractOntology({ ...opts, provider: 'gemini', model: 'gemini-3.6-flash' }, 'PROMPT');
  check('gemini sends response_format', captured.body.response_format !== undefined);
  check('gemini schema has NO additionalProperties', !JSON.stringify(captured.body.response_format).includes('additionalProperties'));
  check('gemini result parses', rg.nodes.length === 2);

  // --- Ollama: format is the bare schema ---
  setScripted({ status: 200, body: { message: { role: 'assistant', content: SCHEMA_REPLY } } });
  const ro = await extractOntology({ ...opts, provider: 'ollama', model: 'qwen3:8b', apiKey: '' }, 'PROMPT');
  check('ollama sends format as bare schema', captured.body.format?.type === 'object');
  check('ollama format has no additionalProperties', !JSON.stringify(captured.body.format).includes('additionalProperties'));
  check('ollama result parses', ro.nodes.length === 2);

  // --- the guardrail: a model that IGNORES the schema and wraps in markdown ---
  setScripted({ status: 200, body: { message: { role: 'assistant', content: '```json\n' + SCHEMA_REPLY + '\n```' } } });
  const rf = await extractOntology({ ...opts, provider: 'ollama', model: 'qwen3:8b', apiKey: '' }, 'PROMPT');
  check('markdown-fenced reply still salvaged', rf.nodes.length === 2 && rf.relationships.length === 1);

  // --- invalid entity type falls back to CONCEPT (schema can't guarantee this) ---
  setScripted({ status: 200, body: { message: { role: 'assistant', content: JSON.stringify({
    entities: [{ name: 'Thing', entity_type: 'NONSENSE', description: '' }], relationships: [] }) } } });
  const rb = await extractOntology({ ...opts, provider: 'ollama', model: 'qwen3:8b', apiKey: '' }, 'PROMPT');
  check('unknown entity_type now DROPPED, not silently coerced', rb.nodes.length === 0, JSON.stringify(rb.nodes));

  // --- relationship naming an unknown entity is dropped, not crashed on ---
  setScripted({ status: 200, body: { message: { role: 'assistant', content: JSON.stringify({
    entities: [{ name: 'A', entity_type: 'CONCEPT', description: '' }],
    relationships: [{ source: 'A', target: 'Ghost', relationship: 'uses', description: '' }] }) } } });
  const rd = await extractOntology({ ...opts, provider: 'ollama', model: 'qwen3:8b', apiKey: '' }, 'PROMPT');
  check('dangling relationship handled without throwing', rd.nodes.length === 1);

  // --- verifyEntityMatch must not carry the extraction schema or big budget ---
  resetBodies();
  const { verifyEntityMatch } = await import('../src/extraction/llm-client');
  setScripted({ status: 200, body: { content: [{ type: 'text', text: 'yes' }] } });
  const same = await verifyEntityMatch({ ...opts, provider: 'claude', effort: 'high', maxOutputTokens: 16384 },
    { name: 'ML', label: 'CONCEPT' }, { name: 'Machine Learning', label: 'CONCEPT' });
  check('verify returns true on "yes"', same === true);
  check('verify sends no response schema', allBodies[0].output_config?.format === undefined);
  check('verify pins a tiny token budget', allBodies[0].max_tokens === 16, String(allBodies[0].max_tokens));
  check('verify forces minimal effort despite high setting', JSON.stringify(allBodies[0].thinking) === '{"type":"disabled"}');

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
