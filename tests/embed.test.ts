import { getEmbeddings, saveEmbeddingsBinary } from '../src/extraction/llm-client';
import { getEmbeddingDimensions, getEmbeddingRequestConfig, EMBEDDING_MODEL_OPTIONS } from '../src/settings';
import { captured, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

(async () => {
  // --- catalogue ---
  check('text-embedding-004 is gone', !JSON.stringify(EMBEDDING_MODEL_OPTIONS.gemini).includes('text-embedding-004'));
  check('default gemini option is 768 dims (matches old width)', EMBEDDING_MODEL_OPTIONS.gemini[0].dimensions === 768);
  check('@768 id resolves to bare api model', getEmbeddingRequestConfig('gemini', 'gemini-embedding-001@768').apiModel === 'gemini-embedding-001');
  check('@768 carries outputDimensionality', getEmbeddingRequestConfig('gemini', 'gemini-embedding-001@768').outputDimensionality === 768);
  check('full model has no truncation', getEmbeddingRequestConfig('gemini', 'gemini-embedding-001').outputDimensionality === undefined);
  check('dims lookup: @768 -> 768', getEmbeddingDimensions('gemini', 'gemini-embedding-001@768') === 768);
  check('dims lookup: full -> 3072', getEmbeddingDimensions('gemini', 'gemini-embedding-001') === 3072);
  check('unknown model falls back to default dims', getEmbeddingDimensions('gemini', 'who-knows') === 1536);

  // --- gemini wire format ---
  setScripted({ status: 200, body: { embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] } });
  await getEmbeddings({ provider: 'gemini', apiKey: 'k', model: 'gemini-embedding-001@768' }, ['a', 'b']);
  check('url uses bare model name, not the @768 id', captured.url!.includes('/gemini-embedding-001:batchEmbedContents') && !captured.url!.includes('@768'), captured.url);
  check('request carries outputDimensionality', captured.body.requests[0].outputDimensionality === 768);
  check('api key in header', captured.headers['x-goog-api-key'] === 'k');

  setScripted({ status: 200, body: { embeddings: [{ values: [1, 2, 3] }] } });
  await getEmbeddings({ provider: 'gemini', apiKey: 'k', model: 'gemini-embedding-001' }, ['a']);
  check('full model sends no outputDimensionality', captured.body.requests[0].outputDimensionality === undefined);

  // --- ollama batching ---
  setScripted({ status: 200, body: { embeddings: [[1, 2], [3, 4], [5, 6]] } });
  const oll = await getEmbeddings({ provider: 'ollama', apiKey: '', model: 'nomic-embed-text', ollamaHost: 'http://localhost:11434' }, ['a', 'b', 'c']);
  check('ollama uses /api/embed', captured.url === 'http://localhost:11434/api/embed');
  check('ollama sends the whole batch in one request', Array.isArray(captured.body.input) && captured.body.input.length === 3);
  check('ollama returns one vector per input', oll.length === 3);

  setScripted({ status: 200, body: { embeddings: [[1, 2]] } });
  let mismatch = '';
  try { await getEmbeddings({ provider: 'ollama', apiKey: '', model: 'nomic-embed-text' }, ['a', 'b']); }
  catch (e: any) { mismatch = e.message; }
  check('ollama count mismatch is caught (would misalign vectors)', /2 inputs|1 embeddings/.test(mismatch), mismatch);

  // --- the corruption guard ---
  const vault: any = { adapter: { writeBinary: async () => undefined } };
  const good = new Map([['n1', new Float32Array(768)]]);
  await saveEmbeddingsBinary(vault, '/p', good, ['n1'], 768);
  check('matching width writes fine', true);

  const wrong = new Map([['n1', new Float32Array(768)]]);
  let corrupt = '';
  try { await saveEmbeddingsBinary(vault, '/p', wrong, ['n1'], 3072); }
  catch (e: any) { corrupt = e.message; }
  check('REFUSES to zero-pad a 768 vector into a 3072 slot', /Refusing to write embeddings/.test(corrupt), corrupt.slice(0, 80));

  const tooLong = new Map([['n1', new Float32Array(3072)]]);
  let corrupt2 = '';
  try { await saveEmbeddingsBinary(vault, '/p', tooLong, ['n1'], 768); }
  catch (e: any) { corrupt2 = e.message; }
  check('REFUSES to truncate a 3072 vector into a 768 slot', /Refusing to write embeddings/.test(corrupt2), corrupt2.slice(0, 80));

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
