// New (Convex backend) · @cove/runtime — app-bound extension registry surface (pragmatic-refactor Phase 5).
//
// Thin authoring wrapper over the V8-safe src/runtime/extensions/registry.ts. `defineExtensionRegistry({
// name: factory })` registers your extensions by name; an agent opts in via `extensions: ["<name>", ...]` (or
// an inline factory). setup re-runs each registration-only factory to compose its system-prompt fragments and
// (Phase 5b) recover its hook closures — so the factory body must be pure registration (no IO/network).
//
// `cove dev` / `cove build` read the `extensions` export and (re)generate convex/_cove/extensionResolver.ts,
// which installs the registry. Convex-app-bound (like agentRegistry.ts). Pure / V8-safe.

import {
	defineExtensionRegistry,
	getRegisteredExtension,
	listRegisteredExtensions,
	registerExtensionRegistry,
} from "../src/runtime/extensions/registry.ts";

export { defineExtensionRegistry, getRegisteredExtension, listRegisteredExtensions, registerExtensionRegistry };
