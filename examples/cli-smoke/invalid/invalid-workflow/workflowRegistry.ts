// cli-smoke INVALID fixture — invalid workflow handler.
// "broken" is not a defineWorkflow() handler (it's a plain object, not a function), so
// defineWorkflowRegistry() throws at module load (`[cove] defineWorkflowRegistry: "broken" is not a
// defineWorkflow() handler.`). The loader wraps the import failure as a single `[cove] failed to load ...` line.
import { defineWorkflowRegistry } from "../../../../convex/workflowRegistry.ts";

export const workflows = defineWorkflowRegistry({
	// biome-ignore lint/suspicious/noExplicitAny: deliberately a non-handler value for the negative fixture.
	broken: { not: "a function" } as any,
});
