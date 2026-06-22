// cli-smoke INVALID fixture — missing/unresolvable provider.
// The agent configures no model (and no `model: false`), so validateAgentRegistry's provider-resolvable
// check fails with a single `[cove] agent "broken" does not configure a model. ...` line.
import { createAgent } from "../../../../src/runtime/agent-definition.ts";
import { defineAgentRegistry } from "../../../../convex/agentRegistry.ts";

export const registry = defineAgentRegistry({
	// No `model` field — unrunnable default → validation error.
	broken: createAgent(() => ({ instructions: "I have no model configured." })),
});
