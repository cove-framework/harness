// New (Convex backend) · @cove/runtime — extension runner (pragmatic-refactor Phase 5).
//
// Instantiates an extension factory against a RECORDING registration API and collects what it contributed:
// tools, system-prompt fragments, and handler closures keyed by event (in registration order). Two consumers:
//   • the pre-setup load action derives the serialized {@link ExtensionManifestEntry} (data only) to freeze;
//   • the per-action binder re-runs factories to recover the live handler closures (the manifest can't carry
//     closures across the journal).
// Per-extension error isolation: a factory that throws is recorded as an error and does NOT abort the others.
// Pure / V8-safe: factory bodies are user code but the registration API is side-effect-free.

import type {
	ExtensionEventName,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionManifestEntry,
	ExtensionRegistration,
	ExtensionRegistrationAPI,
} from "./types.ts";

/**
 * Resolve an agent's `extensions` specs (registered names | inline factories) into an ordered list of
 * (name, factory) pairs to load. Inline factories are named `inline:<index>` (anonymous in the manifest).
 * A name with no registered factory is reported in `missing` (the caller warns + skips), never thrown.
 */
export function resolveExtensionSpecs(
	specs: ReadonlyArray<string | ExtensionFactory>,
	getRegistered: (name: string) => ExtensionFactory | undefined,
): { resolved: Array<{ name: string; factory: ExtensionFactory }>; missing: string[] } {
	const resolved: Array<{ name: string; factory: ExtensionFactory }> = [];
	const missing: string[] = [];
	let inlineIndex = 0;
	for (const spec of specs) {
		if (typeof spec === "function") {
			resolved.push({ name: `inline:${inlineIndex++}`, factory: spec });
			continue;
		}
		const factory = getRegistered(spec);
		if (factory) resolved.push({ name: spec, factory });
		else missing.push(spec);
	}
	return { resolved, missing };
}

export interface RunExtensionResult {
	name: string;
	registration: ExtensionRegistration;
	/** Non-null when the factory threw (isolated — other extensions still load). */
	error?: string;
}

/**
 * Instantiate one factory against a recording API. The factory body must be pure registration; any throw is
 * captured (the returned `error`) and the partial registration up to the throw is still returned, so a single
 * bad extension never aborts the load (porting pi's try/catch-per-extension isolation).
 */
export async function runExtensionFactory(name: string, factory: ExtensionFactory): Promise<RunExtensionResult> {
	const registration: ExtensionRegistration = {
		tools: [],
		systemPromptFragments: [],
		handlers: new Map<ExtensionEventName, ExtensionHandler[]>(),
	};
	const api: ExtensionRegistrationAPI = {
		registerTool: (tool) => void registration.tools.push(tool),
		registerSystemPromptFragment: (fragment) => void registration.systemPromptFragments.push(fragment),
		on: (event, handler) => {
			const list = registration.handlers.get(event) ?? [];
			list.push(handler);
			registration.handlers.set(event, list);
		},
	};
	try {
		await factory(api);
		return { name, registration };
	} catch (err) {
		return { name, registration, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Derive the serialized, order-stable manifest entry (data only — no closures) from a live registration. */
export function toManifestEntry(name: string, registration: ExtensionRegistration): ExtensionManifestEntry {
	return {
		name,
		tools: registration.tools.map((t) => t.name),
		systemPromptFragments: [...registration.systemPromptFragments],
		// Registration order: Map preserves insertion order of first-subscribed events.
		events: [...registration.handlers.keys()],
	};
}

/**
 * Load an ordered list of (name, factory) pairs into a serialized manifest plus the per-name live
 * registrations. Order is preserved (it makes the hook chain deterministic regardless of registry iteration).
 * Errors are collected per-extension, never thrown.
 */
export async function loadExtensions(
	specs: ReadonlyArray<{ name: string; factory: ExtensionFactory }>,
): Promise<{
	manifest: ExtensionManifestEntry[];
	registrations: Map<string, ExtensionRegistration>;
	errors: Array<{ name: string; error: string }>;
}> {
	const manifest: ExtensionManifestEntry[] = [];
	const registrations = new Map<string, ExtensionRegistration>();
	const errors: Array<{ name: string; error: string }> = [];
	for (const spec of specs) {
		const result = await runExtensionFactory(spec.name, spec.factory);
		registrations.set(spec.name, result.registration);
		manifest.push(toManifestEntry(spec.name, result.registration));
		if (result.error) errors.push({ name: spec.name, error: result.error });
	}
	return { manifest, registrations, errors };
}
