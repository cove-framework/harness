// New (Convex backend) · @cove/runtime — app-bound tool registry surface (pragmatic-refactor Phase 3).
//
// Thin authoring wrapper over the V8-safe src/runtime/tool-registry.ts. `defineToolRegistry({ name: tool })`
// collects your MODULE-SCOPE tools by name so the durable engine can recover each tool's `execute` closure
// per isolate — the closure can't cross the @convex-dev/workflow journal, so dispatchTools re-resolves it by
// name from this registry, and setup freezes only the model-facing descriptor. (A tool defined inline inside
// an agent's initialize() can't be recovered this way and is skipped at setup with an observable warn.)
//
// `cove dev` / `cove build` read the `tools` export below and (re)generate convex/_cove/toolResolver.ts,
// which installs the registry. Convex-app-bound (like agentRegistry.ts / workflowRegistry.ts). Pure / V8-safe.

import {
	defineToolRegistry,
	getRegisteredTool,
	listRegisteredTools,
	registerToolRegistry,
} from "../src/runtime/tool-registry.ts";

export { defineToolRegistry, getRegisteredTool, listRegisteredTools, registerToolRegistry };
