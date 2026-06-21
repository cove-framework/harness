// New (Convex backend) · @cove/runtime — defineAgentRegistry (doc 05 "Agent registry", D18). Convex has no
// filesystem-module agent addressing, so agents are registered as an explicit name→CreatedAgent map. This is
// **Convex-app-bound** (exported from the app surface under convex/, NOT the pure @cove/runtime barrel).
// Validation is load-bearing (OS file-existence no longer guards names): names match
// ^[A-Za-z][A-Za-z0-9_-]*$, keys are unique (object keys), each value carries the __coveCreatedAgent brand.
// The module-scoped active registry is the seam setup/codegen consult to resolve an agent by name (the
// full setup integration + the `cove` CLI/codegen that emits app wiring are the P8.5 tooling layer). Pure.

import type { CreatedAgent } from "../src/runtime/types.ts";

const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface AgentManifestEntry {
	name: string;
}

export interface AgentRegistry {
	get(name: string): CreatedAgent | undefined;
	has(name: string): boolean;
	listAgents(): AgentManifestEntry[];
	readonly names: readonly string[];
}

/** Validate + freeze a name→createAgent() map into an addressable registry. */
export function defineAgentRegistry(map: Record<string, CreatedAgent>): AgentRegistry {
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error("[cove] defineAgentRegistry() requires a name → createAgent() map.");
	}
	const names = Object.keys(map);
	for (const name of names) {
		if (!AGENT_NAME_RE.test(name)) {
			throw new Error(
				`[cove] defineAgentRegistry: agent name "${name}" must start with a letter and contain only letters, numbers, "_", or "-".`,
			);
		}
		const agent = map[name] as { __coveCreatedAgent?: unknown } | undefined;
		if (!agent || agent.__coveCreatedAgent !== true) {
			throw new Error(`[cove] defineAgentRegistry: "${name}" is not a createAgent() value.`);
		}
	}
	const frozen: Record<string, CreatedAgent> = { ...map };
	return {
		get: (name) => frozen[name],
		has: (name) => Object.hasOwn(frozen, name),
		listAgents: () => names.map((name) => ({ name })),
		names,
	};
}

// ── Module-scoped active registry (the codegen'd app entry installs it; setup resolves by name) ──
let activeRegistry: AgentRegistry | undefined;

export function registerAgentRegistry(registry: AgentRegistry): void {
	activeRegistry = registry;
}

export function getRegisteredAgent(name: string): CreatedAgent | undefined {
	return activeRegistry?.get(name);
}

export function listRegisteredAgents(): AgentManifestEntry[] {
	return activeRegistry?.listAgents() ?? [];
}

export function resetAgentRegistryForTests(): void {
	activeRegistry = undefined;
}
