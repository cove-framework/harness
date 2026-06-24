// New (Convex backend) · @cove/runtime
// Pattern source: doc 04 "Tool rebuild from frozen descriptors" + doc 08 §4.5. No single flue file —
// flue built tools once in-process; cove rebuilds them from the FROZEN descriptor in BOTH journaled
// actions: llmStep needs the model-facing view (execute stripped), dispatchTools needs the executable.
// The frozen schema (name/description/parameters) is authoritative for the whole run; the executable is
// rebound per action (built-in → SessionEnv; user → re-resolved + normalized; result → the bundle;
// mcp → a network client, P10). A build failure degrades to an error tool-result — never a step crash.
//
// Pure / V8-safe: normalizeToolDefinition (valibot, pure) + framework/result tools; no AI SDK/Convex.

import { normalizeToolDefinition } from "../../src/runtime/tool.ts";
import type { SessionEnv, ToolDefinition, ToolResult } from "../../src/runtime/types.ts";
import { applyToolCallHooks, applyToolResultHooks, type BoundHooks } from "../../src/runtime/extensions/apply.ts";
import type { ExtensionContext } from "../../src/runtime/extensions/types.ts";
import { createFrameworkTool } from "./frameworkTools.ts";
import type { ResultToolBundle } from "./resultTools.ts";
import type {
	EngineToolContent,
	EngineTool,
	EngineToolResult,
	FrozenToolDescriptor,
	ModelToolView,
} from "./types.ts";

/** What dispatchTools provides so executables can be rebound from frozen descriptors. */
export interface BuildToolsSources {
	/** Session sandbox env — binds built-in tools. Absent in llmStep (model view only). */
	env?: SessionEnv;
	/** User tool definitions re-resolved by name from the agent profile/registry. */
	userTools?: Map<string, ToolDefinition>;
	/** The per-call finish/give_up bundle, when the run declares a result schema. */
	resultBundle?: ResultToolBundle<unknown>;
	/**
	 * Per-beat MCP resolver (G2.2). Supplied ONLY by the "use node" dispatchTools action (it opens a
	 * network client via the connection pool), so buildExecutableTools stays pure for llmStep/model-view.
	 * Absent → an MCP descriptor degrades to an error tool-result.
	 */
	mcpResolve?: (descriptor: FrozenToolDescriptor) => EngineTool;
}

/**
 * The model-facing tool view: name/description/parameters straight from the frozen
 * descriptors. Used by llmStep to hand `streamText` the run's authoritative tool surface
 * with `execute` stripped (the model only ever sees the JSON-Schema view).
 */
export function buildModelView(descriptors: FrozenToolDescriptor[]): ModelToolView[] {
	return descriptors.map((d) => ({
		name: d.name,
		description: d.description,
		parameters: d.parameters,
	}));
}

/**
 * Rebuild the executable tool map dispatchTools invokes, keyed by tool name. Each
 * descriptor is rebound by kind; any construction failure yields an error-tool stub
 * (calling it returns an error tool-result) so a single bad tool never crashes the step.
 */
export function buildExecutableTools(
	descriptors: FrozenToolDescriptor[],
	sources: BuildToolsSources,
): Map<string, EngineTool> {
	const map = new Map<string, EngineTool>();
	for (const d of descriptors) {
		map.set(d.name, buildExecutable(d, sources));
	}
	return map;
}

function buildExecutable(d: FrozenToolDescriptor, sources: BuildToolsSources): EngineTool {
	try {
		switch (d.kind) {
			case "builtin": {
				const tool = sources.env ? createFrameworkTool(d.name, sources.env) : undefined;
				return tool ?? errorTool(d, `built-in tool "${d.name}" is unavailable (no sandbox env).`);
			}
			case "result": {
				const tool = sources.resultBundle?.tools.find((t) => t.name === d.name);
				return tool ?? errorTool(d, `result tool "${d.name}" is unavailable.`);
			}
			case "user": {
				const def = sources.userTools?.get(d.name);
				if (!def) return errorTool(d, `tool "${d.name}" could not be resolved from the registry.`);
				return userToolToEngineTool(def);
			}
			case "mcp": {
				// Re-resolve a network MCP client from the frozen descriptor, fresh every beat (doc 08 §4.5).
				// The resolver itself never throws — it returns an EngineTool that degrades (connect/drift) to
				// an error tool-result at execute time. Absent resolver (e.g. llmStep model-view) → degrade.
				if (!sources.mcpResolve) return errorTool(d, `MCP tool "${d.name}" is unavailable (no resolver).`);
				return sources.mcpResolve(d);
			}
			case "task":
				// task is intercepted by dispatchTools (it spawns a child workflow); never executed here.
				return errorTool(d, `task tool "${d.name}" is handled by the loop, not the dispatcher.`);
			case "skill":
				// activate_skill is intercepted by dispatchTools (catalog query, not the box); never here.
				return errorTool(d, `skill tool "${d.name}" is handled by the loop, not the dispatcher.`);
			default:
				return errorTool(d, `unknown tool kind for "${d.name}".`);
		}
	} catch (err) {
		// A build-time throw (e.g. a bad valibot schema in normalizeToolDefinition) becomes an
		// error tool-result, never a step crash (doc 08 §4.5).
		return errorTool(d, getErrorMessage(err));
	}
}

/** Adapt a user ToolDefinition (execute → string | ToolResult) to an EngineTool (execute → EngineToolResult). */
function userToolToEngineTool(def: ToolDefinition): EngineTool {
	const normalized = normalizeToolDefinition(def);
	return {
		name: normalized.name,
		description: normalized.description,
		parameters: normalized.parameters,
		// execute-time throws propagate to the dispatcher, which encodes them as error tool-results.
		async execute(args, signal) {
			return toEngineToolResult(await normalized.execute(args as never, signal));
		},
	};
}

/** Normalize a user tool's `string | ToolResult` return into the engine's EngineToolResult. */
function toEngineToolResult(out: string | ToolResult): EngineToolResult {
	if (typeof out === "string") return { content: [{ type: "text", text: out }] };
	if (out && typeof out === "object" && Array.isArray(out.content)) {
		return { content: out.content as EngineToolContent[], details: out.details, isError: out.isError };
	}
	// Unknown shape (a tool returning neither string nor ToolResult) — stringify defensively.
	return { content: [{ type: "text", text: JSON.stringify(out) }] };
}

/**
 * Freeze the model-facing descriptors for a profile's user tools (pragmatic-refactor Phase 3). The
 * `execute` closure can't cross the workflow journal, so only the descriptor is frozen; dispatchTools
 * recovers the closure by NAME from the tool registry. Pure + unit-testable: setup.ts supplies the
 * `isRegistered` predicate (getRegisteredTool) and the already-frozen `existingNames`, and handles the
 * I/O (warn on skipped, throw on collision). A tool not recoverable by name (e.g. defined inline inside
 * initialize()) is reported in `skipped` rather than frozen — surfacing a tool that always errors is worse.
 */
export interface FreezeUserToolsResult {
	descriptors: FrozenToolDescriptor[];
	/** Names skipped because they are not recoverable from the tool registry. */
	skipped: string[];
	/** Names colliding with an already-frozen (built-in/result/etc.) tool. */
	collisions: string[];
}

export function freezeUserToolDescriptors(
	tools: ToolDefinition[],
	existingNames: ReadonlySet<string>,
	isRegistered: (name: string) => boolean,
): FreezeUserToolsResult {
	const descriptors: FrozenToolDescriptor[] = [];
	const skipped: string[] = [];
	const collisions: string[] = [];
	const seen = new Set(existingNames);
	for (const tool of tools) {
		if (seen.has(tool.name)) {
			collisions.push(tool.name);
			continue;
		}
		if (!isRegistered(tool.name)) {
			skipped.push(tool.name);
			continue;
		}
		const normalized = normalizeToolDefinition(tool);
		descriptors.push({
			name: normalized.name,
			description: normalized.description,
			parameters: normalized.parameters,
			kind: "user",
		});
		seen.add(normalized.name);
	}
	return { descriptors, skipped, collisions };
}

/** Coerce a tool_result hook's `content` patch into EngineToolContent[] (array passes through; string wraps). */
function normalizeHookContent(content: unknown): EngineToolContent[] | undefined {
	if (Array.isArray(content)) return content as EngineToolContent[];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return undefined;
}

/**
 * Wrap each executable tool with the extension `tool_call` (before execute — mutate args / block) and
 * `tool_result` (after execute — patch content/details/isError) hooks (pragmatic-refactor Phase 5b). Returns
 * the map unchanged when no such hooks are bound (zero overhead). The wrapped execute runs only on the live
 * dispatch (the action is journaled), so hook effects never need to reconstruct on replay.
 */
export function wrapToolsWithHooks(
	executable: Map<string, EngineTool>,
	hooks: BoundHooks,
	ctx: ExtensionContext,
): Map<string, EngineTool> {
	if (!hooks.has("tool_call") && !hooks.has("tool_result")) return executable;
	const wrapped = new Map<string, EngineTool>();
	for (const [name, tool] of executable) {
		wrapped.set(name, {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			isHitl: tool.isHitl,
			async execute(args, signal) {
				const decision = await applyToolCallHooks(hooks, name, args, ctx);
				if (decision.blocked) {
					const why = decision.reason ? `: ${decision.reason}` : "";
					return { content: [{ type: "text", text: `[cove] tool "${name}" blocked by extension${why}.` }], isError: true };
				}
				const result = await tool.execute(decision.args, signal);
				const patch = await applyToolResultHooks(hooks, name, {
					content: result.content,
					details: result.details,
					isError: result.isError,
				}, ctx);
				return {
					...result,
					content: normalizeHookContent(patch.content) ?? result.content,
					details: "details" in patch ? patch.details : result.details,
					isError: typeof patch.isError === "boolean" ? patch.isError : result.isError,
				};
			},
		});
	}
	return wrapped;
}

/** A stub tool whose execute always returns an error tool-result with the build failure message. */
function errorTool(d: FrozenToolDescriptor, message: string): EngineTool {
	return {
		name: d.name,
		description: d.description,
		parameters: d.parameters,
		async execute() {
			return { content: [{ type: "text", text: `[cove] ${message}` }], isError: true };
		},
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
