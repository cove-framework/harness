// New (Convex backend) · @cove/runtime
// Engine-internal shared shapes for the durable loop (setup → llmStep → dispatchTools → finalize).
// No flue equivalent — flue carried these in-memory across an in-process turn loop; cove crosses a
// journaled action split, so the *persisted* row shapes (toolCalls/toolResults on agentRequestSteps)
// are the source of truth and these types mirror the schema validators in convex/schema.ts.
//
// Pure / V8-safe: type-only; no Convex, no AI SDK.

/**
 * Kind of a frozen tool descriptor. The frozen schema (name/description/params)
 * is authoritative for the whole run; the executable is rebound per action from
 * this kind (doc 08 §4.5):
 *   - builtin  — a framework tool bound to the session's SessionEnv (fs/exec).
 *   - user     — a profile-declared ToolDefinition, re-resolved + normalized.
 *   - result   — the per-call finish/give_up pair for a result-schema run.
 *   - mcp      — a network MCP tool, re-resolved from server identity (P10).
 */
export type FrozenToolKind = "builtin" | "user" | "result" | "mcp" | "task" | "skill";

/** A frozen, journaled tool descriptor: the model-facing schema + how to rebind execute. */
export interface FrozenToolDescriptor {
	name: string;
	description: string;
	/** Model-facing JSON Schema for the tool arguments. Authoritative for the run. */
	parameters: unknown;
	kind: FrozenToolKind;
	/** Approval-gated tool (HITL); the loop parks before dispatch (P7). */
	isHitl?: boolean;
	/** MCP server identity + transport (P10); present only when kind === "mcp". */
	mcp?: { serverId: string; transport: unknown };
}

export interface EngineToolContentText {
	type: "text";
	text: string;
}
export interface EngineToolContentImage {
	type: "image";
	data: string;
	mimeType: string;
}
export type EngineToolContent = EngineToolContentText | EngineToolContentImage;

/** A tool's execution result. Mirrors the canonical ToolResultMessage payload. */
export interface EngineToolResult {
	content: EngineToolContent[];
	details?: unknown;
	/** True when the tool failed; surfaced to the model as an error tool-result (it self-corrects). */
	isError?: boolean;
	/** A terminal control tool (finish/give_up) fired; the loop terminalizes after this batch. */
	terminate?: boolean;
}

/** An executable tool the dispatcher invokes. The richer engine counterpart of AgentTool. */
export interface EngineTool {
	name: string;
	description: string;
	/** Model-facing JSON Schema. */
	parameters: unknown;
	isHitl?: boolean;
	execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<EngineToolResult>;
}

/** The model-facing tool view handed to the provider (name/description/parameters). */
export interface ModelToolView {
	name: string;
	description: string;
	parameters: unknown;
}

/** A finalized tool call decoded from a step (mirrors agentRequestSteps.toolCalls[]). */
export interface ToolCallRecord {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	isHitl?: boolean;
}

/** A persisted tool result (mirrors agentRequestSteps.toolResults[]). */
export interface ToolResultRecord {
	toolCallId: string;
	toolName: string;
	result: unknown;
	isError?: boolean;
	errorKind?: string;
}

/** The decision a single llmStep returns to the loop. */
export interface StepDecision {
	finishReason: string;
	toolCalls: ToolCallRecord[];
	/** Final assistant text for the step (used for ResultUnavailableError trailing text + finalText). */
	text: string;
	/** Proactive-threshold compaction signal (compaction lands P12; false for P4). */
	shouldCompact: boolean;
}
