/**
 * Build the extraction prompt for the LLM.
 * Designed to handle Korean/English mixed content and normalize entities.
 */
export function buildExtractionPrompt(
	noteContent: string,
	keywords: string[],
	existingEntities: string[]
): string {
	const keywordSection = keywords.length > 0
		? `User-defined keywords (ontology terms):\n${keywords.map(k => `- ${k}`).join('\n')}`
		: 'User-defined keywords: (none defined yet)';

	const existingSection = existingEntities.length > 0
		? `Existing entities in the knowledge graph (reuse these exact names when the same concept appears):\n${existingEntities.slice(0, 50).join(', ')}${existingEntities.length > 50 ? ` ... and ${existingEntities.length - 50} more` : ''}`
		: 'Existing entities: (none yet - this is the first note)';

	return `You are a knowledge graph extraction assistant. Extract structured information from the note below.

## Task
1. **Entities**: Extract key concepts, people, methods, tools, organizations, etc.
2. **Keyword Matches**: Identify which user keywords are semantically relevant to this note
3. **Relationships**: Find meaningful connections between extracted entities

## ${keywordSection}

## ${existingSection}

## Note Content
---
${noteContent}
---

## Output Format
Respond with valid JSON only (no markdown, no explanation):
{"entities":["entity1","entity2"],"keywordMatches":["keyword1"],"relationships":[{"source":"entity1","target":"entity2","type":"relates_to"}]}

## Guidelines
- **Entity extraction**: Focus on domain-specific concepts, not generic words. Include people, methods, tools, theories, organizations.
- **NORMALIZATION**:
  - Merge synonyms and variants into a single canonical form
  - Korean preferred for Korean concepts: "ML", "Machine Learning", "머신러닝", "기계학습" → "머신러닝"
  - English preferred for English-origin terms: "API", "에이피아이" → "API"
  - If an existing entity matches, use that exact name
- **Keyword matching**: Only include keywords that are semantically central to the note's topic, not merely mentioned in passing
- **Relationships**: Connect entities that have meaningful relationships in the context of this note (e.g., "사용한다", "기반으로 한다", "관련 있다")
- **Language handling**: Process Korean and English equally well. Preserve the original language of proper nouns.`;
}

/**
 * Truncate note content if too long for API limits.
 * Preserves beginning and end of content.
 */
export function truncateContent(content: string, maxLength = 12000): string {
	if (content.length <= maxLength) {
		return content;
	}

	const halfLength = Math.floor(maxLength / 2) - 50;
	const beginning = content.slice(0, halfLength);
	const ending = content.slice(-halfLength);

	return `${beginning}\n\n[... content truncated for length ...]\n\n${ending}`;
}
