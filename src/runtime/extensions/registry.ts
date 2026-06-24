// New (Convex backend) · @cove/runtime — defineExtensionRegistry (pragmatic-refactor Phase 5).
//
// Name-keyed sidecar mirroring agentRegistry.ts / tool-registry.ts. Cove has no filesystem module addressing
// (pi's .pi/extensions discovery + jiti loader are dropped), so extensions are registered by name in a
// `defineExtensionRegistry({...})` map (emitted by `cove build`) OR supplied inline as factories on
// AgentProfile.extensions. The factory is re-instantiated per isolate to recover its handler closures (its
// body is pure registration, so re-running is safe). Module-scoped, empty on cold boot, re-registered per
// isolate. Pure / V8-safe.

import type { ExtensionFactory } from "./types.ts";

const EXTENSION_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

export interface ExtensionManifestName {
	name: string;
}

export interface ExtensionRegistry {
	get(name: string): ExtensionFactory | undefined;
	has(name: string): boolean;
	listExtensions(): ExtensionManifestName[];
	readonly names: readonly string[];
}

/** Validate + freeze a name → ExtensionFactory map into an addressable registry. */
export function defineExtensionRegistry(map: Record<string, ExtensionFactory>): ExtensionRegistry {
	if (!map || typeof map !== "object" || Array.isArray(map)) {
		throw new Error("[cove] defineExtensionRegistry() requires a name → extension factory map.");
	}
	const names = Object.keys(map);
	for (const name of names) {
		if (!EXTENSION_NAME_RE.test(name)) {
			throw new Error(
				`[cove] defineExtensionRegistry: extension name "${name}" must start with a letter and contain only letters, numbers, "_", or "-".`,
			);
		}
		if (typeof map[name] !== "function") {
			throw new Error(`[cove] defineExtensionRegistry: "${name}" is not an extension factory function.`);
		}
	}
	const frozen: Record<string, ExtensionFactory> = { ...map };
	return {
		get: (name) => frozen[name],
		has: (name) => Object.hasOwn(frozen, name),
		listExtensions: () => names.map((name) => ({ name })),
		names,
	};
}

// ── Module-scoped active registry (the codegen'd sidecar installs it; the load action resolves by name) ──
let activeRegistry: ExtensionRegistry | undefined;

export function registerExtensionRegistry(registry: ExtensionRegistry): void {
	activeRegistry = registry;
}

export function getRegisteredExtension(name: string): ExtensionFactory | undefined {
	return activeRegistry?.get(name);
}

export function listRegisteredExtensions(): ExtensionManifestName[] {
	return activeRegistry?.listExtensions() ?? [];
}

export function resetExtensionRegistryForTests(): void {
	activeRegistry = undefined;
}
