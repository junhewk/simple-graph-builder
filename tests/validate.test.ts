import { extractOntology } from '../src/extraction/llm-client';
import { validateAgainstSchema, ONTOLOGY_JSON_SCHEMA } from '../src/extraction/providers/schemas';
import { setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const opts = { apiKey: 'k', model: 'claude-sonnet-5', effort: 'minimal' as const, maxOutputTokens: 4096, provider: 'claude' as const };
const reply = (o: unknown) => setScripted({ status: 200, body: { content: [{ type: 'text', text: JSON.stringify(o) }] } });

const ent = (o: any) => ({ name: 'A', entity_type: 'CONCEPT', description: '', ...o });
const rel = (o: any) => ({ source: 'A', target: 'B', relationship: 'uses', description: '', ...o });

(async () => {
  // --- validator unit checks ---
  check('valid payload has no violations',
    validateAgainstSchema({ entities: [ent({})], relationships: [] }, ONTOLOGY_JSON_SCHEMA).length === 0);
  check('bad enum is caught',
    validateAgainstSchema({ entities: [ent({ entity_type: 'NOPE' })], relationships: [] }, ONTOLOGY_JSON_SCHEMA)
      .some(v => v.path === '$.entities[0].entity_type'));
  check('missing required is caught',
    validateAgainstSchema({ entities: [{ name: 'A', entity_type: 'CONCEPT' }], relationships: [] }, ONTOLOGY_JSON_SCHEMA)
      .some(v => /description/.test(v.path) && /missing/.test(v.message)));
  check('wrong scalar type is caught',
    validateAgainstSchema({ entities: [ent({ name: 42 })], relationships: [] }, ONTOLOGY_JSON_SCHEMA)
      .some(v => v.path === '$.entities[0].name'));
  check('extra property is caught (additionalProperties:false)',
    validateAgainstSchema({ entities: [ent({ bogus: 1 })], relationships: [] }, ONTOLOGY_JSON_SCHEMA)
      .some(v => v.path === '$.entities[0].bogus'));
  check('non-array entities is caught',
    validateAgainstSchema({ entities: {}, relationships: [] }, ONTOLOGY_JSON_SCHEMA)
      .some(v => v.path === '$.entities'));
  check('nested path is reported precisely',
    validateAgainstSchema({ entities: [ent({}), ent({ entity_type: 'X' })], relationships: [] }, ONTOLOGY_JSON_SCHEMA)[0].path === '$.entities[1].entity_type');

  // --- envelope violations are fatal ---
  for (const [label, payload] of [
    ['missing entities', { relationships: [] }],
    ['entities not an array', { entities: 'nope', relationships: [] }],
    ['missing relationships', { entities: [] }],
    ['not an object at all', [1, 2, 3]],
  ] as [string, unknown][]) {
    reply(payload);
    let msg = '';
    try { await extractOntology(opts, 'p'); } catch (e: any) { msg = e.message; }
    check(`envelope: ${label} -> throws`, /does not match the extraction schema/.test(msg), msg.slice(0, 60));
  }

  // --- item violations drop the item, keep the rest ---
  reply({ entities: [ent({ name: 'Good' }), ent({ name: 'Bad', entity_type: 'NONSENSE' })], relationships: [] });
  const r1 = await extractOntology(opts, 'p');
  check('invalid entity dropped, valid kept', r1.nodes.length === 1 && r1.nodes[0].properties.name === 'Good',
    JSON.stringify(r1.nodes.map(n => n.properties.name)));

  reply({ entities: [ent({ name: 'A' }), ent({ name: 'B' })],
          relationships: [rel({}), rel({ relationship: 99 })] });
  const r2 = await extractOntology(opts, 'p');
  check('invalid relationship dropped, valid kept', r2.relationships.length === 1, `${r2.relationships.length}`);

  // --- case variance is absorbed, not treated as a violation ---
  reply({ entities: [ent({ name: 'Ada', entity_type: 'person' })], relationships: [] });
  const r3 = await extractOntology(opts, 'p');
  check('lowercase entity_type normalised, not dropped', r3.nodes.length === 1 && r3.nodes[0].entityType === 'PERSON',
    JSON.stringify(r3.nodes));

  // --- a fully valid payload still round-trips ---
  reply({ entities: [ent({ name: 'A' }), ent({ name: 'B' })], relationships: [rel({})] });
  const r4 = await extractOntology(opts, 'p');
  check('valid payload: 2 nodes + 1 edge, endpoints resolved',
    r4.nodes.length === 2 && r4.relationships.length === 1 &&
    r4.relationships[0].source === r4.nodes[0].id && r4.relationships[0].target === r4.nodes[1].id);

  // --- model that cannot do structured output is refused before any request ---
  let refused = '';
  try { await extractOntology({ ...opts, model: 'claude-3-opus-20240229' }, 'p'); }
  catch (e: any) { refused = e.message; }
  check('known-unsupported model refused up front', /cannot return structured output/.test(refused), refused.slice(0, 70));

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
