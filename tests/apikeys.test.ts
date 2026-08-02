import { getSmartSearchConfig, DEFAULT_SETTINGS, CURRENT_SETTINGS_VERSION } from '../src/settings';
import { resolveModelConfig, getExtractionConfigError } from '../src/extraction/providers/models';
import { migrateSettings } from '../src/settings-migration';
import { settingsToEmbeddingOptions } from '../src/extraction/llm-client';
import { Settings } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const S = (o: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...o } as Settings);

// THE BUG: extraction on Claude, Smart Search on OpenAI.
const cross = S({
  apiProvider: 'claude',
  apiKeys: { claude: 'sk-ant-CLAUDE', openai: 'sk-OPENAI' },
  useSeparateSmartSearchModel: true,
  smartSearchProvider: 'openai',
});
check('extraction gets the Claude key', resolveModelConfig(cross, 'extraction').apiKey === 'sk-ant-CLAUDE');
check('SMART SEARCH GETS THE OPENAI KEY (was the Claude key)', getSmartSearchConfig(cross).apiKey === 'sk-OPENAI', getSmartSearchConfig(cross).apiKey);

// three providers, three keys, no crosstalk
const all = S({ apiKeys: { claude: 'K-C', openai: 'K-O', gemini: 'K-G' }, useSeparateSmartSearchModel: true });
for (const [p, k] of [['claude','K-C'],['openai','K-O'],['gemini','K-G']] as const) {
  check(`smartSearchProvider=${p} -> ${k}`, getSmartSearchConfig({ ...all, smartSearchProvider: p }).apiKey === k);
}

// legacy fallback: an install that never set per-provider keys
const legacy = S({ apiKey: 'LEGACY', apiKeys: {}, apiProvider: 'gemini' });
check('falls back to the legacy shared key', resolveModelConfig(legacy, 'extraction').apiKey === 'LEGACY');

// migration seeds the map from the shared key
const m = migrateSettings(S({ apiKey: 'OLD-KEY', apiProvider: 'openai', apiKeys: {} }), 2);
check('migration attributes the old key to its provider', m.settings.apiKeys.openai === 'OLD-KEY', JSON.stringify(m.settings.apiKeys));
check('migration does not guess other providers', m.settings.apiKeys.claude === undefined);
check('version bumped to 3', m.settings.settingsVersion === CURRENT_SETTINGS_VERSION && CURRENT_SETTINGS_VERSION === 3);
const m2 = migrateSettings(m.settings, m.settings.settingsVersion);
check('migration is idempotent', m2.notes.length === 0);
const keep = migrateSettings(S({ apiKey: 'SHARED', apiProvider: 'claude', apiKeys: { claude: 'ALREADY' } }), 2);
check('does not clobber an existing per-provider key', keep.settings.apiKeys.claude === 'ALREADY');

// embeddings: dedicated key wins, then the provider's key, then legacy
check('embedding: dedicated key wins',
  settingsToEmbeddingOptions(S({ embeddingProvider: 'openai', embeddingApiKey: 'EMB', apiKeys: { openai: 'K-O' }, apiKey: 'L' })).apiKey === 'EMB');
check('embedding: falls back to that provider key',
  settingsToEmbeddingOptions(S({ embeddingProvider: 'openai', embeddingApiKey: '', apiKeys: { openai: 'K-O' }, apiKey: 'L' })).apiKey === 'K-O');
check('embedding: does NOT borrow another provider key',
  settingsToEmbeddingOptions(S({ embeddingProvider: 'gemini', embeddingApiKey: '', apiKeys: { openai: 'K-O' }, apiKey: '' })).apiKey === '');
check('embedding: legacy shared key still works',
  settingsToEmbeddingOptions(S({ embeddingProvider: 'openai', embeddingApiKey: '', apiKeys: {}, apiKey: 'LEGACY' })).apiKey === 'LEGACY');

// THE 0.4.3 BUG: fresh install saves a per-provider key, legacy apiKey stays
// empty, and the analyze guards (which read settings.apiKey directly) blocked
// analysis with "Please configure your API key in settings".
const fresh = S({ apiProvider: 'claude', apiKey: '', apiKeys: { claude: 'sk-ant-X', openai: 'sk-O' } });
check('guard passes with only a per-provider key', getExtractionConfigError(fresh) === null,
  String(getExtractionConfigError(fresh)));
check('guard still blocks when no key anywhere', getExtractionConfigError(S({ apiKey: '', apiKeys: {} })) !== null);
check('guard ignores keys for OTHER providers', getExtractionConfigError(S({ apiProvider: 'claude', apiKey: '', apiKeys: { openai: 'sk-O' } })) !== null);
check('legacy-only install still passes', getExtractionConfigError(S({ apiKey: 'LEGACY', apiKeys: {} })) === null);
check('ollama needs no key', getExtractionConfigError(S({ apiProvider: 'ollama', apiKey: '', apiKeys: {} })) === null);
check('ollama without a model is blocked', getExtractionConfigError(S({ apiProvider: 'ollama', ollamaModel: '' })) !== null);

console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
process.exit(fail ? 1 : 0);
