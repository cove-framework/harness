// New (Convex backend) · @cove/runtime — built-in ProviderPlugins (pragmatic-refactor Phase 2).
//
// The four shipped providers (anthropic, openai, google, bedrock) expressed as ProviderPlugins and
// self-registered on import, so the framework dogfoods the same registration path a third party uses
// (mirrors pi's `registerBuiltInApiProviders()` running at import). Each plugin delegates to the
// existing pure helpers (CAPABILITIES, buildBuiltinProviderOptions) so the plugin path returns
// IDENTICAL results to the legacy literals it fronts — zero behavior change.
//
// Pure / V8-safe: NO AI SDK, NO "use node". Imported for its side effect by gateway.ts (node) and
// setup.ts (V8) so plugins are active in both model-resolution contexts.

import { CAPABILITIES, type ModelCaps } from "./capabilities.ts";
import { type ProviderPlugin, registerProviderPlugin } from "./plugin.ts";
import { buildBuiltinProviderOptions } from "./thinking.ts";

function has(env: Record<string, string | undefined>, key: string): boolean {
	return typeof env[key] === "string" && env[key] !== "";
}

/** Build a plugin whose caps read the built-in CAPABILITIES table and whose options use the family logic. */
function builtinPlugin(
	id: string,
	hasCredentials: (env: Record<string, string | undefined>) => boolean,
): ProviderPlugin {
	return {
		id,
		caps: (modelId): ModelCaps | undefined => CAPABILITIES[id]?.[modelId],
		buildProviderOptions: (handle, level, opts) => buildBuiltinProviderOptions(handle, level, opts),
		hasCredentials,
	};
}

export const BUILTIN_PROVIDER_PLUGINS: ProviderPlugin[] = [
	builtinPlugin("anthropic", (env) => has(env, "ANTHROPIC_API_KEY")),
	builtinPlugin("openai", (env) => has(env, "OPENAI_API_KEY")),
	builtinPlugin(
		"google",
		(env) =>
			has(env, "GOOGLE_API_KEY") ||
			has(env, "GEMINI_API_KEY") ||
			has(env, "GOOGLE_GENERATIVE_AI_API_KEY") ||
			has(env, "GOOGLE_APPLICATION_CREDENTIALS"),
	),
	builtinPlugin(
		"bedrock",
		(env) =>
			(has(env, "AWS_ACCESS_KEY_ID") && has(env, "AWS_SECRET_ACCESS_KEY")) ||
			has(env, "AWS_PROFILE") ||
			has(env, "AWS_ROLE_ARN") ||
			has(env, "AWS_WEB_IDENTITY_TOKEN_FILE") ||
			has(env, "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
			has(env, "AWS_CONTAINER_CREDENTIALS_FULL_URI"),
	),
];

/** Register all built-in provider plugins. Idempotent (last-write-wins per id). */
export function registerBuiltInProviders(): void {
	for (const plugin of BUILTIN_PROVIDER_PLUGINS) registerProviderPlugin(plugin);
}

// Self-register on import (side effect).
registerBuiltInProviders();
