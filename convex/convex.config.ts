// New (Convex). Registers the @convex-dev/workflow component that backs the
// durable agent loop (convex/engine/runHandler.ts). No flue equivalent — flue
// ran its loop in-process; here it is a durable workflow.
import workflow from "@convex-dev/workflow/convex.config";
import { defineApp } from "convex/server";

// cove-harness registers the durable-execution component that backs the agent
// loop (engine/runHandler.ts). The agent's per-turn work — LLM streaming and
// tool dispatch — runs as durable workflow steps so a crash/redeploy resumes
// from the last committed step instead of restarting the turn. A workpool can
// be added here later to bound concurrent agent runs.
const app = defineApp();
app.use(workflow);

export default app;
