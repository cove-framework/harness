// Demo workflow-registry wiring for the cove-harness dev app (G2.4). In a USER project, `cove build` codegen
// emits this sidecar from the project's convex/workflowRegistry.ts (the `workflows` export); here it registers
// a demo "echo" workflow so the POST /workflows/:name route resolves to a handler and creates a distinct
// kind:"workflow" run. The full workflow-handler execution (CoveContext orchestration) is G2.5; G2.4 wires the
// route → submitWorkflow → run-kind path. Pure / V8-safe.

import { defineWorkflow, defineWorkflowRegistry, registerWorkflowRegistry } from "../workflowRegistry.ts";

const workflows = defineWorkflowRegistry({
	echo: defineWorkflow((_ctx, input) => input),
});

registerWorkflowRegistry(workflows);

export { getRegisteredWorkflow } from "../workflowRegistry.ts";
