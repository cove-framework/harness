// cli-smoke INVALID fixture — non-__coveCreatedAgent value.
// "fake" is a plain object, not a createAgent() value, so defineAgentRegistry() throws the brand check at
// module load (`[cove] defineAgentRegistry: "fake" is not a createAgent() value.`). The loader wraps the
// import failure as a single `[cove] failed to load <file>: ...` line.
import { defineAgentRegistry } from "../../../../convex/agentRegistry.ts";

export const registry = defineAgentRegistry({
	// biome-ignore lint/suspicious/noExplicitAny: deliberately a non-branded value for the negative fixture.
	fake: { model: "anthropic/claude-haiku-4-5" } as any,
});
