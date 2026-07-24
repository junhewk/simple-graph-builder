import { settingsToExtractionOptions, settingsToEmbeddingOptions, getEmbeddings } from '../src/extraction/llm-client';
import { getSmartSearchConfig, DEFAULT_SETTINGS, supportsToolCalling } from '../src/settings';
import { getAdapter } from '../src/extraction/providers/index';
import { Settings } from '../src/types';
import { captured, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

// The exact configuration: local qwen3.6 for chat, cloud OpenAI for embeddings.
const s: Settings = {
  ...DEFAULT_SETTINGS,
  apiProvider: 'ollama',
  apiKey: '',                                   // local server needs none
  localApiStyle: 'openai',
  ollamaHost: 'http://100.122.169.13:8091',
  ollamaModel: 'qwen3.6-27b-mtp-q8',
  smartSearchOllamaModel: 'qwen3.6-27b-mtp-q8',
  enableEmbeddings: true,
  embeddingProvider: 'openai',
  embeddingApiKey: 'sk-cloud-key',
  embeddingModel: 'text-embedding-3-small',
};

(async () => {
  const ex = settingsToExtractionOptions(s);
  check('extraction routes to the local server', ex.provider === 'ollama' && ex.ollamaHost === 'http://100.122.169.13:8091');
  check('extraction uses the OpenAI-compatible style', ex.localApiStyle === 'openai');
  check('extraction model is the served one', ex.model === 'qwen3.6-27b-mtp-q8');

  const ss = getSmartSearchConfig(s);
  check('smart search follows the same local server', ss.provider === 'ollama' && ss.model === 'qwen3.6-27b-mtp-q8');
  check('smart search is not blocked by the tool-calling denylist', supportsToolCalling(s) === true);

  const adapter = getAdapter('ollama', { apiKey: '', ollamaHost: s.ollamaHost, localApiStyle: 'openai' });
  check('local model is allowed to do structured output', adapter.capabilities(s.ollamaModel).structuredOutput === true);

  // extraction request lands on the right endpoint
  setScripted({ status: 200, body: { choices: [{ message: { role: 'assistant', content: '{"entities":[],"relationships":[]}' } }] } });
  const { extractOntology } = await import('../src/extraction/llm-client');
  await extractOntology(ex, 'p');
  check('extraction POSTs to /v1/chat/completions', captured.url === 'http://100.122.169.13:8091/v1/chat/completions', captured.url);
  check('extraction sends no Authorization (no key needed)', captured.headers.Authorization === undefined);

  // embeddings go to the cloud, untouched by the local config
  const emb = settingsToEmbeddingOptions(s);
  check('embeddings resolve to OpenAI cloud', emb.provider === 'openai');
  check('embeddings use the dedicated key, not the empty main key', emb.apiKey === 'sk-cloud-key');
  setScripted({ status: 200, body: { data: [{ index: 0, embedding: [1, 2, 3] }] } });
  await getEmbeddings(emb, ['x']);
  check('embeddings hit api.openai.com, NOT the local box', captured.url === 'https://api.openai.com/v1/embeddings', captured.url);
  check('embeddings send the cloud bearer token', captured.headers.Authorization === 'Bearer sk-cloud-key');

  // the trap: cloud embeddings with no key anywhere
  const noKey = settingsToEmbeddingOptions({ ...s, embeddingApiKey: '' });
  check('no embedding key + no main key => empty, caught before request', noKey.apiKey === '');
  let msg = '';
  try { await getEmbeddings(noKey, ['x']); } catch (e: any) { msg = e.message; }
  check('missing embedding key fails with a config error', /Embedding API key not configured/.test(msg), msg);

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
