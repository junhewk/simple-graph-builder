import assert from 'node:assert/strict';
import { findLiteratureLabel } from '../src/literature/labels';
import { setObsidianLocale } from './obsidian-stub';

for (const version of ['1.7.2', '1.8.6']) {
	setObsidianLocale(version, 'ko');
	assert.equal(findLiteratureLabel(), 'Find more literature…', 'older Obsidian must not call the unavailable language API');
}
for (const version of ['1.8.7', '1.15.0']) {
	setObsidianLocale(version, 'ko');
	assert.equal(findLiteratureLabel(), '다음 문헌 검색…');
	setObsidianLocale(version, 'ko-KR');
	assert.equal(findLiteratureLabel(), '다음 문헌 검색…');
	setObsidianLocale(version, 'en');
	assert.equal(findLiteratureLabel(), 'Find more literature…');
}
console.log('ok   literature labels guard the language API and preserve Obsidian 1.7.2 support');
