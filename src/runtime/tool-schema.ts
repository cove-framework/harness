// Ported verbatim from flue · @flue/runtime · packages/runtime/src/tool-schema.ts
import type * as v from "valibot";

/**
 * Whether a valibot schema produces a top-level JSON Schema `object`, judged by
 * valibot's runtime `type` discriminator. Every LLM provider requires tool
 * arguments to be a top-level object.
 */
export function isTopLevelObjectSchema(schema: v.GenericSchema): boolean {
	const type = (schema as { type?: string }).type;
	return ["object", "strict_object", "loose_object", "object_with_rest"].includes(type ?? "");
}

/** Drop `$schema` (valibot emits draft-07) because providers do not expect it. */
export function stripJsonSchemaMeta(jsonSchema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _schema, ...rest } = jsonSchema as { $schema?: unknown } & Record<
		string,
		unknown
	>;
	return rest;
}
