// cli-smoke fixture (G2.4 acceptance) — a VALID agent registry.
// The user-project authoring surface: `export const registry = defineAgentRegistry({...})` (the export name
// cove codegen targets). One createAgent declares an in-registry subagent ("reviewer") so the
// declared-subagent-exists validation passes. Imports resolve to the repo's shipped registry construct +
// runtime (relative paths — in a real installed project these would be `cove/...` package imports).
import { createAgent, defineAgentProfile } from "../../../src/runtime/agent-definition.ts";
import { defineAgentRegistry } from "../../../convex/agentRegistry.ts";

const reviewer = createAgent(() => ({
	model: "anthropic/claude-haiku-4-5",
	instructions: "Review the assistant's draft for correctness.",
}));

const assistant = createAgent(() => ({
	model: "anthropic/claude-haiku-4-5",
	instructions: "Help the user; delegate review to the reviewer subagent.",
	// Declares the in-registry "reviewer" agent as a delegatable subagent.
	subagents: [defineAgentProfile({ name: "reviewer", model: "anthropic/claude-haiku-4-5" })],
}));

export const registry = defineAgentRegistry({ assistant, reviewer });
