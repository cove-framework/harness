// New (Convex backend) · @cove/runtime
// The @convex-dev/workflow manager backing the durable agent loop (engine/runHandler.ts). No flue
// equivalent — flue ran the loop in-process. Plain V8 module (no "use node").

import { WorkflowManager } from "@convex-dev/workflow";
import { components } from "./_generated/api";

export const workflow = new WorkflowManager(components.workflow);
