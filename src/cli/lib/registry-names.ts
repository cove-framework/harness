// Ported from flue · @flue/cli · packages/cli/src/lib/generated-entry-normalization.ts (lines 1–19) → @cove/cli.
// New (Convex backend). Sanitize a registry key to a collision-free JS identifier for codegen. DROPPED
// `channelVarName` (channels are G2.3). The codegen assigns indices in sorted-key order (callers below
// pass a stable index) so emitted var names are byte-stable across rebuilds — non-deterministic indexing
// would churn the `convex dev` watcher (the content-compare tracker would never see a no-op). The brand/dup
// assertions from flue's `normalizeBuiltModules` live in validation/validate-registry.ts, not here. Pure.

/** Variable name for a generated-entry agent module import. */
export function agentVarName(name: string, index: number): string {
	return builtModuleVarName("handler", "agent", name, index);
}

/** Variable name for a generated-entry workflow module import. */
export function workflowVarName(name: string, index: number): string {
	return builtModuleVarName("workflow", "workflow", name, index);
}

export function builtModuleVarName(prefix: string, fallback: string, name: string, index: number): string {
	const readableName = name.replace(/[^a-zA-Z0-9]/g, "_").replace(/^_+|_+$/g, "") || fallback;
	return `${prefix}_${readableName}_${index}`;
}

/**
 * Assign stable indices to registry names in sorted order. Returns `[name, index]`
 * pairs sorted by name so codegen output is deterministic regardless of the
 * authoring object's key order. (The registry itself preserves declared key
 * order; sorting here is the byte-stability guarantee the watcher relies on.)
 */
export function stableIndexedNames(names: readonly string[]): Array<[string, number]> {
	return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((name, index) => [name, index]);
}
