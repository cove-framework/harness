// New (Convex backend) · @cove/cli — the CLI lib barrel.
// Keeps bin/cove.ts + command imports tidy and exposes the authoring/codegen/validation entry functions for
// programmatic use. DISTINCT from src/runtime/index.ts: the runtime barrel stays V8-safe / Convex-free and
// MUST NOT re-export the registry surface (defineAgentRegistry/defineWorkflow/registerAgentRegistry/…). All
// registry surface lives on the convex/ authoring files + the sidecar resolvers; this barrel only re-exports
// CLI-side helpers, so it does not couple the pure runtime barrel to convex/ (spec §Hardened-contract).
//
// NOTE: this file intentionally does NOT import from "../runtime/index.ts" — keeping that boundary explicit.

// Authoring config.
export { defineCoveConfig, resolveConfig } from "./lib/config.ts";
export type { CoveConfig, UserCoveConfig } from "./lib/config.ts";

// Commands.
export { build } from "./commands/build.ts";
export type { BuildOptions, BuildResult } from "./commands/build.ts";
export { deploy } from "./commands/deploy.ts";
export { dev } from "./commands/dev.ts";

// Codegen entry functions.
export { generateAgentResolver, renderAgentResolver } from "./codegen/generate-agent-registry.ts";
export {
	generateWorkflowResolver,
	renderWorkflowResolver,
} from "./codegen/generate-workflow-registry.ts";
export {
	ensureResolverImports,
	generateHttpEntry,
	patchWorkflowRoute,
} from "./codegen/generate-http-entry.ts";
export { loadAgentRegistry, loadWorkflowRegistry } from "./codegen/registry-loader.ts";
export { writeIfChanged } from "./codegen/write-if-changed.ts";

// Validation entry functions.
export {
	CoveValidationError,
	validateAgentRegistry,
	validateWorkflowRegistry,
} from "./validation/validate-registry.ts";

// Packaging (m3).
export { packageSkills } from "./packaging/package-skills.ts";
export type { CoveSkillsCatalog } from "./packaging/package-skills.ts";

// Registry-name helpers.
export { agentVarName, workflowVarName, stableIndexedNames } from "./lib/registry-names.ts";
