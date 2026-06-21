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
import type { SessionEnv, ToolDefinition } from "../../src/runtime/types.ts";
import { createFrameworkTool } from "./frameworkTools.ts";
import type { ResultToolBundle } from "./resultTools.ts";
import type { EngineTool, FrozenToolDescriptor, ModelToolView } from "./types.ts";

/** What dispatchTools provides so executables can be rebound from frozen descriptors. */
export interface BuildToolsSources {
	/** Session sandbox env — binds built-in tools. Absent in llmStep (model view only). */
	env?: SessionEnv;
	/** User tool definitions re-resolved by name from the agent profile/registry. */
	userTools?: Map<string, ToolDefinition>;
	/** The per-call finish/give_up bundle, when the run declares a result schema. */
	resultBundle?: ResultToolBundle<unknown>;
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
			case "mcp":
				return errorTool(d, `MCP tool "${d.name}" is not available yet (P10).`);
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

/** Adapt a user ToolDefinition (execute → string) to an EngineTool (execute → EngineToolResult). */
function userToolToEngineTool(def: ToolDefinition): EngineTool {
	const normalized = normalizeToolDefinition(def);
	return {
		name: normalized.name,
		description: normalized.description,
		parameters: normalized.parameters,
		// execute-time throws propagate to the dispatcher, which encodes them as error tool-results.
		async execute(args, signal) {
			const out = await normalized.execute(args as never, signal);
			const txt = typeof out === "string" ? out : JSON.stringify(out);
			return { content: [{ type: "text", text: txt }] };
		},
	};
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
