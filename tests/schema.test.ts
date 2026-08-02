import { ONTOLOGY_JSON_SCHEMA, toProviderSchema, EXTRACTION_SCHEMA_NAME } from '../src/extraction/providers/schemas';
import { EXTRACTION_ENTITY_TYPES, VALID_ENTITY_TYPES } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const s: any = ONTOLOGY_JSON_SCHEMA;

// OpenAI strict:true invariants -- every object needs additionalProperties:false
// and every declared property listed in `required`.
function auditStrict(node: any, path = '$'): string[] {
  const errs: string[] = [];
  if (!node || typeof node !== 'object') return errs;
  if (node.type === 'object') {
    if (node.additionalProperties !== false) errs.push(`${path}: missing additionalProperties:false`);
    const props = Object.keys(node.properties ?? {});
    const req: string[] = node.required ?? [];
    for (const p of props) if (!req.includes(p)) errs.push(`${path}.${p}: declared but not in required`);
    for (const p of props) errs.push(...auditStrict(node.properties[p], `${path}.${p}`));
  }
  if (node.type === 'array') errs.push(...auditStrict(node.items, `${path}[]`));
  return errs;
}
const strictErrs = auditStrict(s);
check('schema satisfies OpenAI strict mode', strictErrs.length === 0, strictErrs.join('; '));

check('top level requires entities + relationships', JSON.stringify(s.required) === '["entities","relationships"]');
const ent = s.properties.entities.items;
const rel = s.properties.relationships.items;
check('entity_type enum matches EXTRACTION_ENTITY_TYPES exactly',
  JSON.stringify(ent.properties.entity_type.enum) === JSON.stringify([...EXTRACTION_ENTITY_TYPES]),
  JSON.stringify(ent.properties.entity_type.enum));
check('enum has all 10 types', ent.properties.entity_type.enum.length === 10);
// NOTE is a plugin-generated type for vault notes. If it leaks into the schema
// models will start labelling entities as notes.
check('enum EXCLUDES the plugin-generated NOTE type',
  !ent.properties.entity_type.enum.includes('NOTE'));
check('NOTE is still a valid node type', VALID_ENTITY_TYPES.includes('NOTE' as never));
check('description is required (strict mode needs it)', ent.required.includes('description') && rel.required.includes('description'));
check('relationship endpoints are names not ids', 'source' in rel.properties && 'target' in rel.properties && !('source_id' in rel.properties));
check('schema shape matches what the prompt asks for', 'name' in ent.properties && 'entity_type' in ent.properties && 'relationship' in rel.properties);

// Gemini / Ollama dialect
for (const p of ['gemini', 'ollama'] as const) {
  const out = JSON.stringify(toProviderSchema(ONTOLOGY_JSON_SCHEMA, p));
  check(`${p}: additionalProperties stripped everywhere`, !out.includes('additionalProperties'));
  check(`${p}: enum survives the strip`, out.includes('PERSON') && out.includes('TOPIC'));
  check(`${p}: required survives the strip`, out.includes('"required"'));
}
for (const p of ['claude', 'openai'] as const) {
  check(`${p}: schema passed through untouched`, JSON.stringify(toProviderSchema(ONTOLOGY_JSON_SCHEMA, p)) === JSON.stringify(ONTOLOGY_JSON_SCHEMA));
}
check('stripping does not mutate the original', JSON.stringify(ONTOLOGY_JSON_SCHEMA).includes('additionalProperties'));
check('schema name is stable', EXTRACTION_SCHEMA_NAME === 'ontology_extraction');

// A response that satisfies the schema must survive parseOntologyResponse
console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
process.exit(fail ? 1 : 0);
