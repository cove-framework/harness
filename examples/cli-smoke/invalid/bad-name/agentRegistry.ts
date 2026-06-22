// cli-smoke INVALID fixture — invalid agent name.
// The key "1bad" does not match ^[A-Za-z][A-Za-z0-9_-]*$, so defineAgentRegistry() throws at module load
// (`[cove] defineAgentRegistry: agent name "1bad" must start with a letter ...`). The loader wraps the import
// failure as a single `[cove] failed to load <file>: ...` line.
import { createAgent } from "../../../../src/runtime/agent-definition.ts";
import { defineAgentRegistry } from "../../../../convex/agentRegistry.ts";

export const registry = defineAgentRegistry({
	"1bad": createAgent(() => ({ model: "anthropic/claude-haiku-4-5" })),
});
