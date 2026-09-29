/**
 * The MCP tool surface: six read-only tools over the query engine.
 *
 * Agents already have grep; these give them what grep cannot: resolved
 * wikilinks and backlinks, extracted entities with typed relations and the
 * note each relation came from, and graph-aware ranking.
 */
import type { QueryEngine } from '../query/engine';
import type { NotFound } from '../query/types';
import type { ToolDefinition, ToolRegistry, ToolResult } from './protocol';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const ENTITY_TYPES_PARAM = {
	type: 'array',
	items: { type: 'string' },
	description: 'Only these entity types, e.g. ["PERSON", "CONCEPT"]. See graph_overview for the types in use.',
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
	{
		name: 'search',
		title: 'Search notes and entities',
		description:
			'Search the Obsidian vault. Ranks notes by text match and by closeness in the knowledge graph, so notes ' +
			'about a matched entity rank even when they do not contain the query words. Handles Korean particles. ' +
			'Each note result lists matched words and the entities connecting it to the query. Start here.',
		inputSchema: {
			type: 'object',
			properties: {
				query: { type: 'string', description: 'Words, a concept, or an entity name.' },
				limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Results per section (default 10).' },
				mode: { type: 'string', enum: ['both', 'notes', 'entities'], description: 'What to return (default both).' },
				entity_types: ENTITY_TYPES_PARAM,
				folder: { type: 'string', description: 'Only notes under this vault folder.' },
				around: { type: 'string', description: 'Also rank by closeness to this entity id or note path.' },
			},
			required: ['query'],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: 'get_entity',
		title: 'Get an entity',
		description:
			'An entity from the knowledge graph by id, name, or alias: type, description, aliases, the notes it was ' +
			'extracted from, and its relations in both directions with the note each relation came from.',
		inputSchema: {
			type: 'object',
			properties: {
				entity: { type: 'string', description: 'Entity id (e.g. "concept:transformer"), name, or alias.' },
			},
			required: ['entity'],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: 'get_note',
		title: 'Get a note',
		description:
			'A note by vault path or [[link text]]: tags, aliases, outgoing links, backlinks, the entities it mentions, ' +
			'and other notes sharing those entities. Set include_content to also get its text.',
		inputSchema: {
			type: 'object',
			properties: {
				note: { type: 'string', description: 'Vault-relative path (e.g. "Projects/Plan.md") or link text.' },
				include_content: { type: 'boolean', description: 'Include the note text (default false).' },
				max_chars: { type: 'integer', minimum: 200, maximum: 100000, description: 'Cap on returned text (default 20000).' },
			},
			required: ['note'],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: 'neighbors',
		title: 'Related entities',
		description:
			'Entities within a few relation hops of an entity, each with the path of relation verbs that reaches it.',
		inputSchema: {
			type: 'object',
			properties: {
				entity: { type: 'string', description: 'Entity id, name, or alias.' },
				hops: { type: 'integer', minimum: 1, maximum: 3, description: 'How far to walk (default 1).' },
				direction: { type: 'string', enum: ['both', 'out', 'in'], description: 'Follow relations out of, into, or both (default both).' },
				relation: { type: 'string', description: 'Only relations whose verb contains this text.' },
				entity_types: ENTITY_TYPES_PARAM,
				include_notes: { type: 'boolean', description: 'Also list the notes that mention the entity.' },
				limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Maximum results (default 50).' },
			},
			required: ['entity'],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: 'find_path',
		title: 'How two things connect',
		description:
			'Shortest connection between two entities or notes. Tries entity relations first, then goes through notes ' +
			'(mentions and wikilinks). Each step names the relation and its source note.',
		inputSchema: {
			type: 'object',
			properties: {
				from: { type: 'string', description: 'Entity id/name/alias or note path.' },
				to: { type: 'string', description: 'Entity id/name/alias or note path.' },
				max_hops: { type: 'integer', minimum: 1, maximum: 6, description: 'Longest path to consider (default 4).' },
				through_notes: { type: 'boolean', description: 'Allow paths through notes (default true).' },
			},
			required: ['from', 'to'],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: 'graph_overview',
		title: 'Graph overview',
		description:
			'Size and shape of the knowledge graph: note and entity counts, entity types, the most central entities, and ' +
			'the most common relation verbs. Useful first call to learn what the vault is about.',
		inputSchema: { type: 'object', additionalProperties: false },
		annotations: READ_ONLY,
	},
];

export function createToolRegistry(engine: QueryEngine): ToolRegistry {
	const handlers: Record<string, (args: Args) => Promise<unknown>> = {
		search: async args => {
			await ready(engine);
			return engine.search(args.string('query', true), {
				limit: args.int('limit'),
				mode: args.oneOf('mode', ['both', 'notes', 'entities'] as const),
				types: args.strings('entity_types'),
				pathPrefix: args.string('folder'),
				seed: args.string('around'),
			});
		},
		get_entity: async args => engine.getEntity(args.string('entity', true)),
		get_note: async args => {
			await ready(engine);
			return engine.getNote(args.string('note', true), {
				includeContent: args.bool('include_content'),
				maxChars: args.int('max_chars'),
			});
		},
		neighbors: async args => engine.neighbors(args.string('entity', true), {
			hops: args.int('hops'),
			direction: args.oneOf('direction', ['both', 'out', 'in'] as const),
			relation: args.string('relation'),
			types: args.strings('entity_types'),
			includeNotes: args.bool('include_notes'),
			limit: args.int('limit'),
		}),
		find_path: async args => engine.findPath(args.string('from', true), args.string('to', true), {
			maxHops: args.int('max_hops'),
			throughNotes: args.bool('through_notes'),
		}),
		graph_overview: async () => engine.overview(),
	};

	return {
		list: () => TOOL_DEFINITIONS,
		call(name, rawArgs) {
			const handler = Object.prototype.hasOwnProperty.call(handlers, name) ? handlers[name] : undefined;
			if (!handler) return undefined;
			return run(() => handler(new Args(rawArgs)));
		},
	};
}

async function ready(engine: QueryEngine): Promise<void> {
	await engine.ensureIndexed();
	await engine.settle();
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
	try {
		const value = await fn();
		if (isNotFound(value)) {
			return {
				content: [{ type: 'text', text: JSON.stringify(value) }],
				structuredContent: value as unknown as Record<string, unknown>,
				isError: true,
			};
		}
		return {
			content: [{ type: 'text', text: JSON.stringify(value) }],
			structuredContent: value as Record<string, unknown>,
		};
	} catch (e) {
		// Argument problems are tool errors, so the model can correct and retry.
		const message = e instanceof ArgumentError ? e.message : `Tool failed: ${e instanceof Error ? e.message : String(e)}`;
		return { content: [{ type: 'text', text: message }], isError: true };
	}
}

function isNotFound(value: unknown): value is NotFound {
	return !!value && typeof value === 'object' && 'error' in value && typeof (value as NotFound).error === 'string';
}

class ArgumentError extends Error {}

/** Typed access to tool arguments, rejecting wrong types with a useful message. */
class Args {
	constructor(private readonly raw: Record<string, unknown>) {}

	string(key: string, required: true): string;
	string(key: string, required?: false): string | undefined;
	string(key: string, required = false): string | undefined {
		const value = this.raw[key];
		if (value === undefined || value === null) {
			if (required) throw new ArgumentError(`"${key}" is required.`);
			return undefined;
		}
		if (typeof value !== 'string') throw new ArgumentError(`"${key}" must be a string.`);
		return value;
	}

	int(key: string): number | undefined {
		const value = this.raw[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== 'number' || !Number.isFinite(value)) throw new ArgumentError(`"${key}" must be a number.`);
		return Math.floor(value);
	}

	bool(key: string): boolean | undefined {
		const value = this.raw[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value !== 'boolean') throw new ArgumentError(`"${key}" must be true or false.`);
		return value;
	}

	strings(key: string): string[] | undefined {
		const value = this.raw[key];
		if (value === undefined || value === null) return undefined;
		if (typeof value === 'string') return [value];
		if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
			throw new ArgumentError(`"${key}" must be a list of strings.`);
		}
		return value as string[];
	}

	oneOf<T extends string>(key: string, allowed: readonly T[]): T | undefined {
		const value = this.string(key);
		if (value === undefined) return undefined;
		if (!(allowed as readonly string[]).includes(value)) {
			throw new ArgumentError(`"${key}" must be one of: ${allowed.join(', ')}.`);
		}
		return value as T;
	}
}
