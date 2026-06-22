// Demo agent-registry wiring for the cove-harness dev app (G2.4). In a USER project, `cove build` codegen
// emits this sidecar from the project's convex/agentRegistry.ts (the `registry` export); here it registers a
// demo agent so setup's getRegisteredAgent(name) resolution is live-verifiable. The `_cove` dir is excluded
// from Convex's function scanner but is still importable (the registration side-effect installs the registry
// in the importing function's isolate). Pure / V8-safe — no "use node", no box, no LLM.

import { createAgent } from "../../src/runtime/agent-definition.ts";
import { defineAgentRegistry, registerAgentRegistry } from "../agentRegistry.ts";

const registry = defineAgentRegistry({
	demo: createAgent(() => ({
		model: "cove-test/mock",
		instructions: "Demo agent registered via the G2.4 registry seam.",
	})),
});

registerAgentRegistry(registry);

export { getRegisteredAgent, listRegisteredAgents } from "../agentRegistry.ts";
