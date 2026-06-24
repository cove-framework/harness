// Demo extension-registry wiring for the cove-harness dev app (pragmatic-refactor Phase 5). In a USER
// project, `cove build` codegen emits this sidecar from convex/extensionRegistry.ts (the `extensions` export);
// here it installs an empty registry (the demo agent declares no extensions) so setup.ts can side-effect-import
// it and resolve named extensions. The `_cove` dir is excluded from Convex's function scanner but is still
// importable (the registration side-effect installs the registry in the importing function's isolate). Pure.

import { defineExtensionRegistry, registerExtensionRegistry } from "../extensionRegistry.ts";

const extensions = defineExtensionRegistry({});

registerExtensionRegistry(extensions);

export { getRegisteredExtension, listRegisteredExtensions } from "../extensionRegistry.ts";
