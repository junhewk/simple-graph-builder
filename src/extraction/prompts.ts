import { ExtractionMode, EXTRACTION_ENTITY_TYPES } from '../types';

// ============================================
// Content Chunking
// ============================================

/**
 * Split content into chunks for parallel processing.
 * Target ~500 tokens per chunk (~3 chars per token as compromise between EN ~4 and KR ~2).
 */
export function chunkContent(content: string, targetTokens = 500): string[] {
	const chunkSize = targetTokens * 3; // ~1500 chars per chunk

	const paragraphs = content.split(/\n\n+/);
	const chunks: string[] = [];
	let current = '';

	for (const para of paragraphs) {
		if (current.length + para.length > chunkSize && current) {
			chunks.push(current.trim());
			current = para;
		} else {
			current += (current ? '\n\n' : '') + para;
		}
	}

	if (current.trim()) {
		chunks.push(current.trim());
	}

	// Ensure at least one chunk
	return chunks.length > 0 ? chunks : [content];
}

/**
 * Get extraction limits based on mode.
 * - standard: Max 15 entities per chunk
 * - thorough: No limits
 */
function getExtractionLimits(mode: ExtractionMode): { maxEntities: number | null } {
	switch (mode) {
		case 'standard':
			return { maxEntities: 15 };
		case 'thorough':
			return { maxEntities: null };
	}
}

/**
 * Build the ontology extraction prompt for the LLM.
 * Extracts entities with fixed types and relationships as free-form verbs.
 */
export function buildExtractionPrompt(
	noteContent: string,
	existingNodeNames: string[],
	extractionMode: ExtractionMode = 'standard'
): string {
	const existingSection = existingNodeNames.length > 0
		? `## Existing Entities (reuse exact names when applicable)
${existingNodeNames.slice(0, 100).join(', ')}${existingNodeNames.length > 100 ? ` ... and ${existingNodeNames.length - 100} more` : ''}`
		: '';

	const limits = getExtractionLimits(extractionMode);
	const limitInstruction = limits.maxEntities !== null
		? `Extract up to ${limits.maxEntities} most significant entities.`
		: `Extract ALL significant entities.`;

	const entityTypesList = EXTRACTION_ENTITY_TYPES.join(', ');

	return `You are a knowledge graph builder. Extract entities and relationships from the text below.

## Entity Types (use ONLY these 10)
- PERSON: People, individuals, authors, researchers
- ORGANIZATION: Companies, institutions, teams, communities
- CONCEPT: Ideas, theories, principles, abstract notions
- PROJECT: Projects, products, initiatives, goals
- TOOL: Software, hardware, instruments, utilities
- EVENT: Meetings, conferences, milestones, dates
- PLACE: Locations, venues, geography
- DOCUMENT: Papers, books, articles, notes, creative works
- METHOD: Techniques, approaches, processes, workflows
- TOPIC: Subjects, themes, fields, domains

## Guidelines
1. ${limitInstruction}
2. Use canonical names (expand acronyms except well-known: API, AI, ML)
3. Relationships: use active verbs ("develops", "uses", "causes", "cites", "contains")
4. Korean: Remove particles (Josa), prefer Korean for Korean concepts
5. Keep names SHORT (1-4 words)
6. Skip trivial terms ("thing", "item", "data", "information")

${existingSection}

## Text
${noteContent}

## Output (JSON only, no markdown)
{"entities":[{"name":"...","entity_type":"${entityTypesList.split(', ')[0]}","description":"..."}],"relationships":[{"source":"...","target":"...","relationship":"develops","description":"..."}]}`;
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
