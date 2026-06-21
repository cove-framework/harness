// New (Convex backend) · @cove/runtime — defineWorkflow / defineWorkflowRegistry (doc 05 "Workflows", D18).
// User-authored, code-orchestrated runs over agents: defineWorkflow((ctx, input) => result) → WorkflowHandler.
// Convex-app-bound (exported from convex/, NOT the @cove/runtime barrel), like defineAgentRegistry. A
// workflow run is a distinct run kind from an agent run (runs.kind discriminator). The HTTP POST
// /workflows/:name route (http.ts) resolves against the registered registry; the codegen that wires it is
// the P8.5 tooling layer. Pure / V8-safe.

import type { CoveContext } from "../src/runtime/types.ts";

const WORKFLOW_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** A user-authored workflow handler: receives a CoveContext + input, returns its result. */
export type WorkflowHandler<TInput = unknown, TResult = unknown> = (
	ctx: CoveContext,
	input: TInput,
) => TResult | Promise<TResult>;

/** Mark a function as a workflow handler (validates it is callable). */
export function defineWorkflow<TInput = unknown, TResult = unknown>(
	handler: WorkflowHandler<TInput, TResult>,
): WorkflowHandler<TInput, TResult> {
	if (typeof handler !== "function") {
		throw new Error("[cove] defineWorkflow() requires a handler function.");
	}
	return handler;
}

export interface WorkflowRegistry {
	get(name: string): WorkflowHandler | undefined;
	has(name: string): boolean;
	readonly names: readonly string[];
}

/** Validate + freeze a name→defineWorkflow() map. */
export function defineWorkflowRegistry(map: Record<string, WorkflowHandler>): WorkflowRegistry {
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error("[cove] defineWorkflowRegistry() requires a name → defineWorkflow() map.");
	}
	const names = Object.keys(map);
	for (const name of names) {
		if (!WORKFLOW_NAME_RE.test(name)) {
			throw new Error(`[cove] defineWorkflowRegistry: workflow name "${name}" is invalid.`);
		}
		if (typeof map[name] !== "function") {
			throw new Error(`[cove] defineWorkflowRegistry: "${name}" is not a defineWorkflow() handler.`);
		}
	}
	const frozen: Record<string, WorkflowHandler> = { ...map };
	return {
		get: (name) => frozen[name],
		has: (name) => Object.hasOwn(frozen, name),
		names,
	};
}

// ── Module-scoped active registry (the codegen'd app entry installs it; the /workflows route resolves) ──
let activeRegistry: WorkflowRegistry | undefined;

export function registerWorkflowRegistry(registry: WorkflowRegistry): void {
	activeRegistry = registry;
}

export function getRegisteredWorkflow(name: string): WorkflowHandler | undefined {
	return activeRegistry?.get(name);
}

export function resetWorkflowRegistryForTests(): void {
	activeRegistry = undefined;
}
