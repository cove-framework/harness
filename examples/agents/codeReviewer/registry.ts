// New · @cove example — the addressable registration the codegen installs (G1 / doc 05 "Agent registry").
// Convex has no filesystem-module agent addressing, so the agent is registered as an explicit
// name→createAgent map. `cove dev`/`cove deploy` codegen calls registerAgentRegistry(registry) so setup
// can resolve "codeReviewer" by name (G2.4). defineAgentRegistry validates the name + the createAgent brand.

import { defineAgentRegistry } from "../../../convex/agentRegistry.ts";
import { codeReviewer } from "./agent.ts";

export const registry = defineAgentRegistry({ codeReviewer });
