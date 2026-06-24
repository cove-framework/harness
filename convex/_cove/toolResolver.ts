// Demo tool-registry wiring for the cove-harness dev app (pragmatic-refactor Phase 3). In a USER project,
// `cove build` codegen emits this sidecar from the project's convex/toolRegistry.ts (the `tools` export);
// here it installs an empty registry (the demo agent declares no user tools) so setup.ts/dispatchTools.ts
// can side-effect-import it and resolve user tools by name. The `_cove` dir is excluded from Convex's
// function scanner but is still importable (the registration side-effect installs the registry in the
// importing function's isolate). Pure / V8-safe — no "use node", no box, no LLM.

import { defineToolRegistry, registerToolRegistry } from "../toolRegistry.ts";

const tools = defineToolRegistry({});

registerToolRegistry(tools);

export { getRegisteredTool, listRegisteredTools } from "../toolRegistry.ts";
