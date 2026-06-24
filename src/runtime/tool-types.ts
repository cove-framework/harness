// Ported verbatim from flue · @flue/runtime · packages/runtime/src/tool-types.ts
import type * as v from "valibot";

/**
 * Schema for a custom tool's arguments: a valibot object schema for
 * hand-written tools, or a raw JSON Schema document object as the interop
 * escape hatch — schemas discovered from adapters such as MCP, or produced by
 * other schema libraries (e.g. TypeBox schemas are structurally JSON Schema),
 * pass through unchanged. The raw arm is intentionally `object`: JSON Schema
 * documents have no useful structural type, and schema-builder outputs are
 * interfaces that narrower record types would reject.
 */
export type ToolParameters = v.GenericSchema | object;

/**
 * Arguments delivered to a tool's `execute` callback. Valibot schemas yield
 * their parsed output type; raw JSON Schema parameters yield an untyped record.
 */
export type ToolArgs<TParams extends ToolParameters> = [TParams] extends [v.GenericSchema]
	? v.InferOutput<TParams>
	: Record<string, any>;

/** A text block in a {@link ToolResult}. */
export interface ToolResultContentText {
	type: "text";
	text: string;
}
/** An image block in a {@link ToolResult} (base64 `data` + `mimeType`). */
export interface ToolResultContentImage {
	type: "image";
	data: string;
	mimeType: string;
}
export type ToolResultContent = ToolResultContentText | ToolResultContentImage;

/**
 * Structured tool result — the opt-in richer alternative to returning a plain
 * string from `execute`. Return this to emit images, attach non-model `details`,
 * or flag an error. (Run termination stays reserved for framework result tools.)
 */
export interface ToolResult {
	content: ToolResultContent[];
	/** Side-channel data NOT sent to the model (logging, structured outputs). */
	details?: unknown;
	/** Surfaces to the model as an error tool-result so it self-corrects. */
	isError?: boolean;
}

/**
 * Custom tool passed to createAgent(), init(), prompt(), skill(), or task().
 * Agent and init tools are available to every session call; prompt/skill/task
 * tools are scoped to that call. Build `parameters` with valibot
 * (`v.object({ ... })`), or pass a raw JSON Schema object for schemas produced
 * elsewhere.
 */
export interface ToolDefinition<TParams extends ToolParameters = ToolParameters> {
	/** Must be unique across built-in and custom tools. */
	name: string;
	/** Tells the LLM when and how to use this tool. */
	description: string;
	/** Valibot object schema or raw JSON Schema object. */
	parameters: TParams;
	/**
	 * Returns the result sent back to the LLM: a plain string, or a {@link ToolResult}
	 * for images / error flagging / side-channel details. Thrown errors become tool errors.
	 */
	execute: (args: ToolArgs<TParams>, signal?: AbortSignal) => Promise<string | ToolResult>;
}
