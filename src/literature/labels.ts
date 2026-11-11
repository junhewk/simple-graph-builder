import { getLanguage } from 'obsidian';

export function findLiteratureLabel(): string {
	return typeof getLanguage === 'function' && getLanguage().startsWith('ko') ? '다음 문헌 검색…' : 'Find more literature…';
}
