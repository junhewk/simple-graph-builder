import { getEmbeddings, settingsToEmbeddingOptions } from '../src/extraction/llm-client';
import { DEFAULT_SETTINGS } from '../src/settings';
import { Settings } from '../src/types';
import { captured, setScripted } from './obsidian-stub';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const S = (o: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...o } as Settings);
const CHAT = 'http://100.22.169.13:8091';

(async () => {
  // --- the user's actual setup: local OpenAI-compatible chat + CLOUD embeddings ---
  const cloudEmbed = settingsToEmbeddingOptions(S({
    apiProvider: 'ollama', localApiStyle: 'openai', ollamaHost: CHAT,
    embeddingProvider: 'openai', embeddingApiKey: 'sk-cloud', embeddingModel: 'text-embedding-3-small',
  }));
  check('cloud embeddings stay cloud when chat is local', cloudEmbed.provider === 'openai');
  setScripted({ status: 200, body: { data: [{ index: 0, embedding: [1, 2, 3] }] } });
  await getEmbeddings(cloudEmbed, ['a']);
  check('cloud embeddings hit api.openai.com, not the local box', captured.url === 'https://api.openai.com/v1/embeddings', captured.url);
  check('cloud embeddings use the embedding key', captured.headers.Authorization === 'Bearer sk-cloud');

  // --- local embeddings, OpenAI-compatible ---
  const local = settingsToEmbeddingOptions(S({
    ollamaHost: CHAT, embeddingProvider: 'ollama',
    embeddingLocalApiStyle: 'openai', embeddingModel: 'Qwen3-Embedding-0.6B', embeddingApiKey: '',
  }));
  setScripted({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }, { index: 1, embedding: [3, 4] }] } });
  const v = await getEmbeddings(local, ['a', 'b']);
  check('local openai-style embeddings hit /v1/embeddings', captured.url === `${CHAT}/v1/embeddings`, captured.url);
  check('no Authorization when no key', captured.headers.Authorization === undefined);
  check('returns one vector per input', v.length === 2);

  // --- embedding host overrides the chat host ---
  const split = settingsToEmbeddingOptions(S({
    ollamaHost: CHAT, embeddingProvider: 'ollama',
    embeddingLocalApiStyle: 'ollama', embeddingHost: 'http://192.168.1.5:11434', embeddingModel: 'nomic-embed-text',
  }));
  check('separate embedding host wins over chat host', split.ollamaHost === 'http://192.168.1.5:11434');
  setScripted({ status: 200, body: { embeddings: [[1, 2]] } });
  await getEmbeddings(split, ['a']);
  check('ollama-style local embeddings still use /api/embed', captured.url === 'http://192.168.1.5:11434/api/embed', captured.url);

  // --- blank embedding host falls back to the chat host ---
  const fallback = settingsToEmbeddingOptions(S({ ollamaHost: CHAT, embeddingProvider: 'ollama', embeddingHost: '' }));
  check('blank embedding host falls back to chat host', fallback.ollamaHost === CHAT);

  // --- chat style must NOT leak into embeddings ---
  const independent = settingsToEmbeddingOptions(S({
    localApiStyle: 'openai',           // chat is OpenAI-compatible
    embeddingProvider: 'ollama',
    embeddingLocalApiStyle: 'ollama',  // but embeddings are native Ollama
  }));
  check('chat localApiStyle does not leak into embeddings', independent.localApiStyle === 'ollama');

  // --- count mismatch guard on the OpenAI-style path ---
  setScripted({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } });
  let msg = '';
  try { await getEmbeddings(local, ['a', 'b']); } catch (e: any) { msg = e.message; }
  check('short response caught (would misalign vectors)', /1 vectors for 2 inputs/.test(msg), msg);

  console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
  process.exit(fail ? 1 : 0);
})();
