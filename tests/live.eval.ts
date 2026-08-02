/**
 * LIVE end-to-end eval: real HTTP calls to each cloud provider you have a key
 * for in the environment. Not part of `npm test` — run with:
 *
 *   ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... npm run eval
 *
 * Reproduces the 0.4.3 bug report exactly: keys saved per-provider only, the
 * legacy shared `apiKey` left empty (as on every fresh install). Asserts the
 * pre-flight guard passes and that the full chunked extraction pipeline
 * returns a sane ontology from each live provider. Cheap models, minimal
 * effort — one short note per provider.
 */
import { DEFAULT_SETTINGS } from '../src/settings';
import { getExtractionConfigError } from '../src/extraction/providers/models';
import { extractOntologyChunked, settingsToExtractionOptions } from '../src/extraction/llm-client';
import { Settings, ApiProvider, EntityType } from '../src/types';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const ENTITY_TYPES: EntityType[] = [
	'PERSON', 'ORGANIZATION', 'CONCEPT', 'PROJECT', 'TOOL',
	'EVENT', 'PLACE', 'DOCUMENT', 'METHOD', 'TOPIC',
];

const NOTE = `Ada Lovelace worked with Charles Babbage on the Analytical Engine.
She published the first algorithm intended for the machine in her 1843 notes,
and is regarded as a pioneer of the field of computing.`;

const KEYS: Partial<Record<ApiProvider, string | undefined>> = {
	claude: process.env.ANTHROPIC_API_KEY,
	openai: process.env.OPENAI_API_KEY,
	gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
};

const CHEAP_MODEL: Partial<Record<ApiProvider, string>> = {
	claude: 'claude-haiku-4-5',
	openai: 'gpt-5.4-mini',
	gemini: 'gemini-3.5-flash-lite',
};

// Settings shaped exactly like the bug reporter's install: per-provider keys
// saved through the settings UI, legacy shared key never populated.
function userShapedSettings(provider: ApiProvider): Settings {
	return {
		...DEFAULT_SETTINGS,
		apiProvider: provider,
		apiKey: '',
		apiKeys: Object.fromEntries(
			Object.entries(KEYS).filter(([, v]) => v)
		) as Settings['apiKeys'],
		claudeModel: CHEAP_MODEL.claude!,
		openaiModel: CHEAP_MODEL.openai!,
		geminiModel: CHEAP_MODEL.gemini!,
		extractionEffort: 'minimal',
	};
}

(async () => {
	const providers = (Object.keys(KEYS) as ApiProvider[]).filter((p) => KEYS[p]);

	if (providers.length === 0) {
		console.log('skip: no API keys in env (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) — nothing evaluated');
		process.exit(0);
	}

	for (const provider of providers) {
		const settings = userShapedSettings(provider);

		// The guard that produced "Please configure your API key in settings"
		// on exactly this settings shape before the fix.
		check(`${provider}: pre-flight guard passes with per-provider key only`,
			getExtractionConfigError(settings) === null, String(getExtractionConfigError(settings)));

		try {
			const options = settingsToExtractionOptions(settings);
			const { result, chunkCount } = await extractOntologyChunked(options, NOTE, [], 'standard');

			check(`${provider}: extracted at least one node`, result.nodes.length > 0,
				`${result.nodes.length} nodes in ${chunkCount} chunk(s)`);
			check(`${provider}: every entity type is one of the 10 fixed types`,
				result.nodes.every((n) => ENTITY_TYPES.includes(n.entityType)),
				result.nodes.map((n) => n.entityType).join(','));
			check(`${provider}: extracted at least one relationship`, result.relationships.length > 0,
				`${result.relationships.length} relationships`);
			console.log(`     ${provider} nodes: ${result.nodes.map((n) => `${n.properties.name} [${n.entityType}]`).join(', ')}`);
		} catch (e) {
			fail++;
			console.log(`FAIL ${provider}: live extraction threw :: ${(e as Error).message}`);
		}
	}

	const skipped = (Object.keys(KEYS) as ApiProvider[]).filter((p) => !KEYS[p]);
	if (skipped.length > 0) console.log(`skip: no key for ${skipped.join(', ')}`);

	console.log(fail ? `\n${fail} FAILURES` : '\nall pass');
	process.exit(fail ? 1 : 0);
})();
