"use node";
// New (Convex backend) · @cove/runtime · mirrors flue packages/runtime/src/index.ts barrel shape
// Narrowed to the two Cove built-ins. Re-exports the names imported by
// `engine/setup` (P4) and the app wiring. Note: this barrel transitively pulls
// the `"use node"` upstashBox/localBash adapters, so it carries "use node" itself
// (Convex bundles each convex/*.ts as an entry point — a barrel re-exporting node
// adapters must be a Node module). The pure scaffolding (sessionEnv.ts / abort.ts)
// stays importable from anywhere via their own modules.

export { upstashBox, type UpstashBoxClient, type UpstashBoxOptions } from "./upstashBox.ts";
export { localBash, nodeBashLike, type LocalBashOptions } from "./localBash.ts";
export {
	bash,
	createCwdSessionEnv,
	createSandboxSessionEnv,
	type SandboxApi,
	type SessionEnv,
} from "./sessionEnv.ts";
