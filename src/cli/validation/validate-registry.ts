// New (Convex backend) · @cove/cli — build-time registry validation.
// Ports the brand/dup-name assertions from flue · @flue/cli · packages/cli/src/lib/
// generated-entry-normalization.ts `normalizeBuiltModules` (lines 32–56), rebranded
// `__flueCreatedAgent`→`__coveCreatedAgent` / `[flue]`→`[cove]`, and layers on the cove-specific
// declared-subagent-exists + provider-resolvable + config-shape checks.
//
// Runs INSIDE the registry-loader's tsx child (registry-loader.ts), where the live AgentRegistry /
// WorkflowRegistry objects exist (the createAgent initializer can't be JSON-serialized, so validation
// that needs the live object happens in-child and reports text diagnostics).
//
// The agent name regex + `__coveCreatedAgent` brand + key uniqueness are already enforced by
// `defineAgentRegistry()` (convex/agentRegistry.ts:25–48) and the workflow name regex + callable check by
// `defineWorkflowRegistry()` (convex/workflowRegistry.ts:35–54). We route through those (single-sourced
// regex) and add: (a) declared subagents exist in the registry (mirrors SubagentNotDeclaredError);
// (b) a resolvable provider (`<provider>/<model>` shape, or `model:false`); (c) compaction/durability
// shape (the same field allowlist as agent-definition.ts's file-private assertCompaction/assertDurability).
//
// Each failure is a single `[cove]` line (CoveValidationError.message). Pure — no Convex, no box, no LLM.

import type { AgentRegistry } from "../../../convex/agentRegistry.ts";
import type { WorkflowRegistry } from "../../../convex/workflowRegistry.ts";
import { resolveAgentProfile } from "../../runtime/agent-definition.ts";
import type { AgentProfile, AgentRuntimeConfig, CreatedAgent } from "../../runtime/types.ts";

/** A single `[cove]`-prefixed validation failure. */
export class CoveValidationError extends Error {
	constructor(message: string) {
		super(message.startsWith("[cove]") ? message : `[cove] ${message}`);
		this.name = "CoveValidationError";
	}
}

/**
 * Validate an already-constructed AgentRegistry. `defineAgentRegistry()` has
 * already run name-regex + brand + uniqueness; here we resolve each agent's
 * profile and check subagents-exist + provider-resolvable + config-shape.
 *
 * Throws CoveValidationError (single `[cove]` line) on the first failure.
 */
export async function validateAgentRegistry(registry: AgentRegistry): Promise<void> {
	const declared = new Set(registry.names);
	for (const name of registry.names) {
		const agent = registry.get(name) as CreatedAgent | undefined;
		// `defineAgentRegistry` guarantees the brand, but re-assert defensively so a
		// hand-built registry object (bypassing defineAgentRegistry) still fails loud.
		if (!agent || agent.__coveCreatedAgent !== true || typeof agent.initialize !== "function") {
			throw new CoveValidationError(`agent "${name}" is not a createAgent() value.`);
		}

		// Resolve the initializer to its runtime config. The initializer is the
		// user's function — run it with a stub create context (id/env/payload).
		let config: AgentRuntimeConfig;
		try {
			config = await agent.initialize({ id: `cove-build:${name}`, env: {}, payload: undefined });
		} catch (err) {
			throw new CoveValidationError(
				`agent "${name}" initializer threw during validation: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		let profile: AgentProfile;
		try {
			// resolveAgentProfile() runs assertAgentRuntimeConfig (rejects unknown
			// fields) + folds profile/runtime values; it throws `[cove]` on bad shape.
			profile = resolveAgentProfile(config);
		} catch (err) {
			throw new CoveValidationError(
				`agent "${name}" has an invalid runtime config: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		assertProviderResolvable(name, profile.model);
		assertCompactionShape(name, profile.compaction);
		assertDurabilityShape(name, profile.durability);
		assertSubagentsDeclared(name, profile.subagents, declared);
	}
}

/** Validate an already-constructed WorkflowRegistry (defineWorkflowRegistry ran name+callable checks). */
export function validateWorkflowRegistry(registry: WorkflowRegistry): void {
	for (const name of registry.names) {
		const handler = registry.get(name);
		if (typeof handler !== "function") {
			throw new CoveValidationError(`workflow "${name}" is not a defineWorkflow() handler.`);
		}
	}
}

// ─── Field-level checks ───────────────────────────────────────────────────────

/**
 * A provider must be resolvable: `model` is a non-empty `<provider>/<model>`
 * string (mirrors gateway.ts resolveModel's slash split), OR `model:false`
 * (require call-level selection), OR a subagent declares its own — but a
 * registry agent without any model is an unrunnable default, so we require it.
 */
function assertProviderResolvable(name: string, model: AgentProfile["model"]): void {
	if (model === false) return; // explicit "require call-level model" — allowed.
	if (model === undefined) {
		throw new CoveValidationError(
			`agent "${name}" does not configure a model. Return \`model: "<provider>/<model>"\` ` +
				`(e.g. "anthropic/claude-haiku-4-5") or \`model: false\` to require call-level selection.`,
		);
	}
	if (typeof model !== "string" || model.trim().length === 0) {
		throw new CoveValidationError(`agent "${name}" model must be a non-empty "<provider>/<model>" string.`);
	}
	// The mock seam (`cove-test/mock`) is intentionally allowed (dev runs).
	const slash = model.indexOf("/");
	if (slash <= 0 || slash >= model.length - 1) {
		throw new CoveValidationError(
			`agent "${name}" model "${model}" is not in the "<provider>/<model>" format ` +
				`(e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
}

/** Mirrors agent-definition.ts assertCompaction (file-private) field allowlist. */
function assertCompactionShape(name: string, compaction: AgentProfile["compaction"]): void {
	if (compaction === undefined || compaction === false) return;
	for (const key of Object.keys(compaction)) {
		if (key !== "reserveTokens" && key !== "keepRecentTokens" && key !== "model") {
			throw new CoveValidationError(`agent "${name}" compaction received unknown field "${key}".`);
		}
	}
	assertTokenCount(name, "compaction.reserveTokens", compaction.reserveTokens);
	assertTokenCount(name, "compaction.keepRecentTokens", compaction.keepRecentTokens);
	if (compaction.model !== undefined && typeof compaction.model !== "string") {
		throw new CoveValidationError(`agent "${name}" compaction.model must be a string.`);
	}
}

/** Mirrors agent-definition.ts assertDurability (file-private) field allowlist. */
function assertDurabilityShape(name: string, durability: AgentProfile["durability"]): void {
	if (durability === undefined) return;
	for (const key of Object.keys(durability)) {
		if (key !== "maxAttempts" && key !== "timeoutMs") {
			throw new CoveValidationError(`agent "${name}" durability received unknown field "${key}".`);
		}
	}
	assertPositiveInteger(name, "durability.maxAttempts", durability.maxAttempts);
	assertPositiveInteger(name, "durability.timeoutMs", durability.timeoutMs);
}

/** Declared subagents must exist in the registry (mirrors SubagentNotDeclaredError). */
function assertSubagentsDeclared(
	name: string,
	subagents: AgentProfile["subagents"],
	declared: Set<string>,
): void {
	for (const subagent of subagents ?? []) {
		const subName = subagent?.name;
		if (typeof subName !== "string" || subName.length === 0) continue; // shape is validated by resolveAgentProfile.
		if (!declared.has(subName)) {
			throw new CoveValidationError(
				`agent "${name}" declares subagent "${subName}" not present in the registry.`,
			);
		}
	}
}

function assertTokenCount(name: string, label: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
		throw new CoveValidationError(`agent "${name}" ${label} must be a non-negative integer.`);
	}
}

function assertPositiveInteger(name: string, label: string, value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		throw new CoveValidationError(`agent "${name}" ${label} must be a positive integer.`);
	}
}
