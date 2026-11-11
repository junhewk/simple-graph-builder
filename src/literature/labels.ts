import { getLanguage, requireApiVersion } from 'obsidian';

export function findLiteratureLabel(): string {
	if (requireApiVersion('1.8.7')) {
		return getLanguage().startsWith('ko') ? '다음 문헌 검색…' : 'Find more literature…';
	}
	return 'Find more literature…';
}
