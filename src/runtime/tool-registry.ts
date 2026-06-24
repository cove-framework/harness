// New (Convex backend) · @cove/runtime — defineToolRegistry (pragmatic-refactor Phase 0).
//
// Name-keyed sidecar that lets the durable engine recover user-tool *closures* per isolate
// WITHOUT re-running the agent initializer. The frozen runPlan carries only serializable tool
// *descriptors* (name/description/JSON-Schema params); the `execute` closure cannot cross the
// workflow journal. This registry is the `initialize`-free recovery path: `cove build` emits a
// `defineToolRegistry({...})` sidecar from the registered agents' module-scope tools, the sidecar
// self-installs on every isolate that touches llmStep/dispatchTools, and dispatch recovers the
// closure by name via getRegisteredTool(name). Mirrors `convex/agentRegistry.ts` exactly (module
// scoped, empty on cold boot, re-registered per isolate). Pure / V8-safe — no AI SDK, no "use node".
//
// Phase 0 lands this empty + unused; Phase 3 wires dispatchTools + the `cove build` codegen.

import type { ToolDefinition } from "./tool-types.ts";

export interface ToolManifestEntry {
	name: string;
}

export interface ToolRegistry {
	get(name: string): ToolDefinition | undefined;
	has(name: string): boolean;
	listTools(): ToolManifestEntry[];
	readonly names: readonly string[];
}

/**
 * Validate + freeze a name → ToolDefinition map into an addressable registry.
 * Each value must be a tool definition (a `defineTool(...)` result), and its map
 * key must equal the tool's own `name` so `getRegisteredTool(name)` is unambiguous.
 */
export function defineToolRegistry(map: Record<string, ToolDefinition>): ToolRegistry {
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error("[cove] defineToolRegistry() requires a name → tool definition map.");
	}
	const names = Object.keys(map);
	for (const name of names) {
		const tool = map[name] as Partial<ToolDefinition> | undefined;
		if (!tool || typeof tool !== "object") {
			throw new Error(`[cove] defineToolRegistry: "${name}" is not a tool definition object.`);
		}
		if (tool.name !== name) {
			throw new Error(
				`[cove] defineToolRegistry: key "${name}" does not match tool name "${String(tool.name)}". Register each tool under its own name.`,
			);
		}
		if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
			throw new Error(`[cove] defineToolRegistry: tool "${name}" requires a non-empty description.`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object") {
			throw new Error(`[cove] defineToolRegistry: tool "${name}" requires parameters.`);
		}
		if (typeof tool.execute !== "function") {
			throw new Error(`[cove] defineToolRegistry: tool "${name}".execute must be a function.`);
		}
	}
	const frozen: Record<string, ToolDefinition> = { ...map };
	return {
		get: (name) => frozen[name],
		has: (name) => Object.hasOwn(frozen, name),
		listTools: () => names.map((name) => ({ name })),
		names,
	};
}

// ── Module-scoped active registry (the codegen'd sidecar installs it; dispatch resolves by name) ──
let activeRegistry: ToolRegistry | undefined;

export function registerToolRegistry(registry: ToolRegistry): void {
	activeRegistry = registry;
}

export function getRegisteredTool(name: string): ToolDefinition | undefined {
	return activeRegistry?.get(name);
}

export function listRegisteredTools(): ToolManifestEntry[] {
	return activeRegistry?.listTools() ?? [];
}

export function resetToolRegistryForTests(): void {
	activeRegistry = undefined;
}
