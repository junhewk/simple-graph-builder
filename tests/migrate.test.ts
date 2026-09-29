import { migrateSettings } from '../src/settings-migration';
import { DEFAULT_SETTINGS, CURRENT_SETTINGS_VERSION } from '../src/settings';
import { Settings } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };
const run = (over: Partial<Settings> & Record<string, unknown>, v = 0) => migrateSettings({ ...DEFAULT_SETTINGS, ...over } as Settings, v);

// The real-world case: a 0.3.8 install's stored settings.
const legacy = run({
  claudeModel: 'claude-sonnet-4-5-20250929',
  openaiModel: 'gpt-5-mini',
  geminiModel: 'gemini-2.5-flash',
  ollamaModel: 'gpt-oss:20b',
  smartSearchClaudeModel: 'claude-sonnet-4-5-20250929',
  smartSearchOpenaiModel: 'gpt-4o',
  smartSearchGeminiModel: 'gemini-2.5-pro',
  smartSearchOllamaModel: 'qwen3:32b',
  embeddingModel: 'text-embedding-3-small',
});
const s = legacy.settings;
check('claude dated snapshot -> claude-sonnet-5', s.claudeModel === 'claude-sonnet-5', s.claudeModel);
check('gpt-5-mini -> gpt-5.4-mini', s.openaiModel === 'gpt-5.4-mini', s.openaiModel);
check('gemini-2.5-flash -> gemini-3.6-flash', s.geminiModel === 'gemini-3.6-flash', s.geminiModel);
check('OLLAMA MODEL UNTOUCHED (local tag on disk)', s.ollamaModel === 'gpt-oss:20b', s.ollamaModel);
check('smart search keys are removed', !Object.keys(s).some(k => k.startsWith('smartSearch')), Object.keys(s).filter(k => k.startsWith('smartSearch')).join());
check('openai embedding model untouched', s.embeddingModel === 'text-embedding-3-small', s.embeddingModel);
check('version stamped', s.settingsVersion === CURRENT_SETTINGS_VERSION);
check('reports changed', legacy.changed === true);

// tier preservation
check('gemini-2.5-flash-lite keeps its lite tier', run({ geminiModel: 'gemini-2.5-flash-lite' }).settings.geminiModel === 'gemini-3.5-flash-lite');
check('gemini-2.0-flash -> 3.6-flash', run({ geminiModel: 'gemini-2.0-flash' }).settings.geminiModel === 'gemini-3.6-flash');
check('gemini-3-pro-preview -> 3.6-flash', run({ geminiModel: 'gemini-3-pro-preview' }).settings.geminiModel === 'gemini-3.6-flash');
check('gpt-4.1-mini -> gpt-5.4-mini', run({ openaiModel: 'gpt-4.1-mini' }).settings.openaiModel === 'gpt-5.4-mini');
check('gpt-5-nano -> gpt-5.4-mini', run({ openaiModel: 'gpt-5-nano' }).settings.openaiModel === 'gpt-5.4-mini');
check('gpt-5.1 -> gpt-5.6-luna', run({ openaiModel: 'gpt-5.1' }).settings.openaiModel === 'gpt-5.6-luna');
check('claude-haiku dated -> claude-haiku-4-5', run({ claudeModel: 'claude-haiku-4-5-20251001' }).settings.claudeModel === 'claude-haiku-4-5');
check('claude-3-opus -> claude-sonnet-5', run({ claudeModel: 'claude-3-opus-20240229' }).settings.claudeModel === 'claude-sonnet-5');
check('dead text-embedding-004 -> gemini-embedding-001@768', run({ embeddingModel: 'text-embedding-004' }).settings.embeddingModel === 'gemini-embedding-001@768');

// extractionMode rename still handled
check('extractionMode simple -> standard', run({ extractionMode: 'simple' as any }).settings.extractionMode === 'standard');
check('extractionMode maximum -> thorough', run({ extractionMode: 'maximum' as any }).settings.extractionMode === 'thorough');

// idempotence + not clobbering deliberate choices
const once = run({ claudeModel: 'claude-sonnet-4-5-20250929' });
const twice = migrateSettings(once.settings, once.settings.settingsVersion);
check('idempotent: second run changes nothing', twice.settings.claudeModel === 'claude-sonnet-5' && twice.notes.length === 0);
const deliberate = run({ claudeModel: 'claude-haiku-4-5' }, CURRENT_SETTINGS_VERSION);
check('already-current version is not re-migrated', deliberate.settings.claudeModel === 'claude-haiku-4-5' && deliberate.notes.length === 0);
const custom = run({ claudeModel: 'my-proxy/custom-model' });
check('unrecognised custom model left alone', custom.settings.claudeModel === 'my-proxy/custom-model', custom.settings.claudeModel);
// v6: Smart Search removal
const current = run({ useSeparateSmartSearchModel: true, smartSearchEffort: 'high' }, CURRENT_SETTINGS_VERSION);
check('smart search keys are removed even at the current version',
  !('useSeparateSmartSearchModel' in current.settings) && !('smartSearchEffort' in current.settings));
check('removal is idempotent', migrateSettings(current.settings, CURRENT_SETTINGS_VERSION).notes.length === 0);
check('current models are stable under migration', run({ claudeModel: 'claude-sonnet-5', openaiModel: 'gpt-5.6-luna', geminiModel: 'gemini-3.6-flash' }).notes.length === 0);

console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
process.exit(fail ? 1 : 0);
