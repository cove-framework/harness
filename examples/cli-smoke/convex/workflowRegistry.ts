// cli-smoke fixture (G2.4 acceptance) — a VALID workflow registry.
// The user-project authoring surface: `export const workflows = defineWorkflowRegistry({...})` (the export
// name cove codegen targets). One defineWorkflow ("echo") proves the route → handler → kind:"workflow" run.
import { defineWorkflow, defineWorkflowRegistry } from "../../../convex/workflowRegistry.ts";

export const workflows = defineWorkflowRegistry({
	echo: defineWorkflow((_ctx, input) => input),
});
