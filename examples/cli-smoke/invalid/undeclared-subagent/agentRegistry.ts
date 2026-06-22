// cli-smoke INVALID fixture — declared subagent not present in the registry.
// "assistant" delegates to a "ghost" subagent that is NOT a registry key, so assertSubagentsDeclared fails
// with a single `[cove] agent "assistant" declares subagent "ghost" not present in the registry.` line
// (mirrors SubagentNotDeclaredError).
import { createAgent, defineAgentProfile } from "../../../../src/runtime/agent-definition.ts";
import { defineAgentRegistry } from "../../../../convex/agentRegistry.ts";

const assistant = createAgent(() => ({
	model: "anthropic/claude-haiku-4-5",
	subagents: [defineAgentProfile({ name: "ghost", model: "anthropic/claude-haiku-4-5" })],
}));

export const registry = defineAgentRegistry({ assistant });
