// New (Convex backend) · @cove/runtime — ProviderPlugin (pragmatic-refactor Phase 2, design §3.1).
//
// Unifies the FOUR previously-hardcoded per-provider switches into one registrable unit so adding a
// provider is one registration instead of four lockstep edits:
//   1. catalog membership   (was CATALOG_PROVIDERS in registry.ts)        → "a plugin is registered"
//   2. capability lookup     (was CAPABILITIES[id][modelId] in capabilities.ts) → caps()
//   3. provider-option shape (was the family branches in thinking.ts)     → buildProviderOptions()
//   4. credential detection  (was the switch in gateway.ts)              → hasCredentials()
//
// Pure / V8-safe: NO AI SDK, NO "use node". Module-scoped + last-write-wins, EMPTY on cold boot —
// re-registered per isolate (same contract as registry.ts `providersById`). Dispatchers consult this
// map FIRST and fall back to the legacy literals during migration (so built-ins are unchanged).

import type { ModelCaps } from "./capabilities.ts";
import type { ModelHandle, ThinkingLevel } from "../../src/runtime/messages.ts";
import type { BuildProviderOptionsOpts, BuiltProviderOptions } from "./thinking.ts";

/**
 * One provider's behaviour, registered as a unit. `caps`/`buildProviderOptions` are pure
 * (V8-safe). `hasCredentials` is ADVISORY only — `resolveModel` never gates on it; the single
 * caller (setup diagnostics) supplies `env` (process.env) explicitly so this stays side-effect-free.
 */
export interface ProviderPlugin {
	/** Provider id used in `"<provider>/<model>"` specifiers. Catalog membership = a plugin exists. */
	readonly id: string;
	/** Capability metadata for a model id, or undefined when this plugin doesn't know it. */
	caps(modelId: string): ModelCaps | undefined;
	/** AI SDK providerOptions + fitted maxTokens for a thinking level (pure; optional). */
	buildProviderOptions?(
		handle: ModelHandle,
		level: ThinkingLevel,
		opts?: BuildProviderOptionsOpts,
	): BuiltProviderOptions;
	/** Advisory credential check from supplied env (never gates resolution). */
	hasCredentials?(env: Record<string, string | undefined>): boolean;
}

// Module-scoped, last-write-wins, empty on cold boot. Built-ins self-register via builtins.ts.
const pluginsById = new Map<string, ProviderPlugin>();

export function registerProviderPlugin(plugin: ProviderPlugin): void {
	pluginsById.set(plugin.id, plugin);
}

export function getProviderPlugin(id: string): ProviderPlugin | undefined {
	return pluginsById.get(id);
}

export function hasProviderPlugin(id: string): boolean {
	return pluginsById.has(id);
}

export function listProviderPlugins(): string[] {
	return [...pluginsById.keys()];
}

/** Clear all plugins. Test-only — restores the cold-boot empty state. */
export function resetProviderPluginsForTests(): void {
	pluginsById.clear();
}
