/**
 * Rewriting med-lit's relative Markdown links into vault wikilinks.
 *
 * The rewrite has to be exact and deterministic: the update merge compares the
 * rewritten text, so any wobble would make every page look changed upstream.
 */
import { nameIndex, toWikilinks } from '../src/import/links';

let fail = 0;
const check = (n: string, c: boolean, extra = '') => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${n}${extra ? ' :: ' + extra : ''}`); };

const F = 'LLM review (bot 2)';
const paths: Record<string, string> = {
	'entities/Empathy.md': `${F}/entities/Empathy.md`,
	"entities/Cronbach's alpha.md": `${F}/entities/Cronbach's alpha.md`,
	'entities/Benjamini–Hochberg procedure.md': `${F}/entities/Benjamini–Hochberg procedure.md`,
	'sources/He 2026 - Effect of LLM-Powered VSPs.md': `${F}/sources/He 2026 - Effect of LLM-Powered VSPs.md`,
	'index.md': `${F}/index.md`,
	'log.md': `${F}/log.md`,
};
const ctx = {
	pathForRel: (rel: string) => paths[rel],
	pathForName: nameIndex(Object.values(paths).filter(p => p.includes('/entities/'))),
};

const fromSource = toWikilinks('- [Empathy](../entities/Empathy.md) · CONCEPT · outcome', 'sources/x.md', ctx);
check('entity link from a source page', fromSource === `- [[${F}/entities/Empathy|Empathy]] · CONCEPT · outcome`, fromSource);

const encoded = toWikilinks("[Cronbach's alpha](../entities/Cronbach%27s%20alpha.md)", 'entities/Empathy.md', ctx);
check('URL-encoded target decoded', encoded === `[[${F}/entities/Cronbach's alpha|Cronbach's alpha]]`, encoded);

const unicode = toWikilinks('[BH](../entities/Benjamini%E2%80%93Hochberg%20procedure.md)', 'sources/x.md', ctx);
check('percent-encoded unicode decoded', unicode === `[[${F}/entities/Benjamini–Hochberg procedure|BH]]`, unicode);

const citation = toWikilinks('as shown [pmc:PMC13601875](../sources/He%202026%20-%20Effect%20of%20LLM-Powered%20VSPs.md).', 'entities/Empathy.md', ctx);
check('citation keeps the uid as label', citation === `as shown [[${F}/sources/He 2026 - Effect of LLM-Powered VSPs|pmc:PMC13601875]].`, citation);

const fromRoot = toWikilinks('See [the update log](log.md) and [Empathy](entities/Empathy.md).', 'index.md', ctx);
check('links from the project root', fromRoot === `See [[${F}/log|the update log]] and [[${F}/entities/Empathy|Empathy]].`, fromRoot);

const bare = toWikilinks('- [[Empathy]] (updated)\n- [[Unknown thing]] (new)\n- [[Empathy|feeling]]', 'updates/2026-10-01.md', ctx);
check('bare report links qualified', bare.startsWith(`- [[${F}/entities/Empathy|Empathy]] (updated)`), bare);
check('unknown bare links untouched', bare.includes('- [[Unknown thing]] (new)'), bare);
check('bare link label kept', bare.endsWith(`[[${F}/entities/Empathy|feeling]]`), bare);

const external = '[doi](https://doi.org/10.1/x) ![img](pic.png) [missing](../entities/Nope.md) [anchor](#top)';
check('external, image, unknown and anchor links untouched', toWikilinks(external, 'sources/x.md', ctx) === external);

const once = toWikilinks('[Empathy](../entities/Empathy.md) and [[Empathy]]', 'sources/x.md', ctx);
check('rewrite is idempotent', toWikilinks(once, 'sources/x.md', ctx) === once, once);

// After the person renames the folder, the same text rewritten against the new
// paths is what Obsidian's own link update produced: the page reads as unchanged.
const renamed = { ...ctx, pathForRel: (rel: string) => paths[rel]?.replace(F, 'Reviews/LLM') };
const moved = toWikilinks('[Empathy](../entities/Empathy.md)', 'sources/x.md', renamed);
check('rewrite follows renamed paths', moved === '[[Reviews/LLM/entities/Empathy|Empathy]]', moved);

const ambiguous = nameIndex(['A/entities/X.md', 'A/sources/X.md']);
check('ambiguous names resolve to nothing', ambiguous('x') === undefined);

console.log(fail === 0 ? 'medlit-links: all checks passed' : `medlit-links: ${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
