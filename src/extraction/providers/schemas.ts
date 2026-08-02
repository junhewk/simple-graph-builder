import { ApiProvider, EXTRACTION_ENTITY_TYPES } from '../../types';
import { JsonSchemaObject } from './types';

export const EXTRACTION_SCHEMA_NAME = 'ontology_extraction';

/**
 * The extraction result shape, expressed once and translated per provider.
 *
 * Two constraints shaped this:
 *
 * - OpenAI's `strict: true` requires `additionalProperties: false` at every
 *   level and every property listed in `required`. That is why `description` is
 *   required rather than optional — the model emits "" when it has nothing to
 *   say. Marking it optional returns a 400.
 * - `source` and `target` are entity *names*, not ids, matching what the prompt
 *   already asks for and what parseOntologyResponse already resolves. Switching
 *   to ids here would break that resolution step.
 *
 * `entity_type` draws its enum from EXTRACTION_ENTITY_TYPES so the schema cannot
 * drift away from the EntityType union. Note that is the 10-type extraction
 * vocabulary, not VALID_ENTITY_TYPES — the latter also contains NOTE, which the
 * plugin generates for vault notes and no model should ever return.
 */
export const ONTOLOGY_JSON_SCHEMA: JsonSchemaObject = {
	type: 'object',
	additionalProperties: false,
	required: ['entities', 'relationships'],
	properties: {
		entities: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['name', 'entity_type', 'description'],
				properties: {
					name: { type: 'string', description: 'Canonical entity name, 1-4 words' },
					entity_type: { type: 'string', enum: [...EXTRACTION_ENTITY_TYPES] },
					description: { type: 'string', description: 'Brief description, may be empty' },
				},
			},
		},
		relationships: {
			type: 'array',
			items: {
				type: 'object',
				additionalProperties: false,
				required: ['source', 'target', 'relationship', 'description'],
				properties: {
					source: { type: 'string', description: 'Name of the source entity' },
					target: { type: 'string', description: 'Name of the target entity' },
					relationship: { type: 'string', description: 'Active verb, e.g. "develops"' },
					description: { type: 'string', description: 'Brief context, may be empty' },
				},
			},
		},
	},
};

/** The per-item schemas, read off the envelope so there is one definition. */
export const ENTITY_ITEM_SCHEMA = (ONTOLOGY_JSON_SCHEMA.properties as Record<string, JsonSchemaObject>)
	.entities.items as JsonSchemaObject;
export const RELATIONSHIP_ITEM_SCHEMA = (
	ONTOLOGY_JSON_SCHEMA.properties as Record<string, JsonSchemaObject>
).relationships.items as JsonSchemaObject;

export interface SchemaViolation {
	path: string;
	message: string;
}

/**
 * Validate a value against the JSON Schema subset this plugin uses:
 * `type` (object/array/string/number/boolean), `enum`, `required`,
 * `properties`, `items`, `additionalProperties: false`.
 *
 * Deliberately hand-rolled rather than pulling in a validator dependency —
 * Obsidian plugins ship their whole bundle, and this covers the schema we
 * actually emit.
 */
export function validateAgainstSchema(
	value: unknown,
	schema: JsonSchemaObject,
	path = '$'
): SchemaViolation[] {
	const violations: SchemaViolation[] = [];
	const expected = schema.type as string | undefined;

	if (expected === 'array') {
		if (!Array.isArray(value)) {
			return [{ path, message: `expected an array, got ${describe(value)}` }];
		}
		const items = schema.items as JsonSchemaObject | undefined;
		if (items) {
			value.forEach((item, i) => {
				violations.push(...validateAgainstSchema(item, items, `${path}[${i}]`));
			});
		}
		return violations;
	}

	if (expected === 'object') {
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			return [{ path, message: `expected an object, got ${describe(value)}` }];
		}
		const obj = value as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchemaObject>;

		for (const key of (schema.required as string[] | undefined) ?? []) {
			if (obj[key] === undefined) {
				violations.push({ path: `${path}.${key}`, message: 'required property is missing' });
			}
		}

		if (schema.additionalProperties === false) {
			for (const key of Object.keys(obj)) {
				if (!(key in properties)) {
					violations.push({ path: `${path}.${key}`, message: 'unexpected property' });
				}
			}
		}

		for (const [key, child] of Object.entries(properties)) {
			if (obj[key] !== undefined) {
				violations.push(...validateAgainstSchema(obj[key], child, `${path}.${key}`));
			}
		}
		return violations;
	}

	// Scalars
	if (value === undefined || value === null) {
		return [{ path, message: `expected ${expected ?? 'a value'}, got ${describe(value)}` }];
	}

	const enumValues = schema.enum as unknown[] | undefined;
	if (enumValues && !enumValues.includes(value)) {
		return [{ path, message: `${JSON.stringify(value)} is not one of ${enumValues.join(', ')}` }];
	}

	if (expected && typeof value !== expected) {
		return [{ path, message: `expected ${expected}, got ${describe(value)}` }];
	}

	return violations;
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	return typeof value;
}

/**
 * Gemini and Ollama validate against an OpenAPI-flavoured subset that rejects
 * `additionalProperties`. Anthropic and OpenAI take the schema as-is.
 */
export function toProviderSchema(schema: JsonSchemaObject, provider: ApiProvider): JsonSchemaObject {
	if (provider === 'gemini' || provider === 'ollama') {
		return stripAdditionalProperties(schema);
	}
	return schema;
}

function stripAdditionalProperties(value: unknown): JsonSchemaObject {
	if (Array.isArray(value)) {
		return value.map(stripAdditionalProperties) as unknown as JsonSchemaObject;
	}
	if (!value || typeof value !== 'object') {
		return value as JsonSchemaObject;
	}

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
		if (key === 'additionalProperties') continue;
		out[key] = child && typeof child === 'object' ? stripAdditionalProperties(child) : child;
	}
	return out;
}
