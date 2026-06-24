// New (Convex backend) · @cove/runtime — extension hook binding + application (pragmatic-refactor Phase 5b).
//
// BIND: re-run the frozen manifest's NAMED factories (registration-only → pure → safe to re-run per isolate)
// to recover their handler closures, merged per event in MANIFEST ORDER (order-stable across isolates, which
// makes a sequential rewrite chain deterministic regardless of registry iteration order). Inline-factory hooks
// are NOT recoverable post-journal (their closures never crossed into the manifest) — they are dropped at bind,
// the same honest constraint as inline-in-initialize tools.
//
// APPLY: pure async folds over the bound handlers for each hook. Content-mutation hooks fold their results
// (last-writer-wins / mutate-by-return); notify hooks are fire-and-forget (errors swallowed). The CALLER places
// these strictly on the live path (behind the runDecode/dispatch replay guard) and supplies only frozen +
// persisted inputs, so the effect that lands in the persisted step is reconstructed identically on replay.
//
// Pure / V8-safe.

import { loadExtensions } from "./runner.ts";
import type { ToolDefinition } from "../tool-types.ts";
import type {
	ExtensionContext,
	ExtensionEvent,
	ExtensionEventName,
	ExtensionFactory,
	ExtensionHandler,
	ExtensionManifestEntry,
	ExtensionRegistration,
} from "./types.ts";

/** Bound hooks: handlers grouped by event, in manifest (registration) order. */
export type BoundHooks = Map<ExtensionEventName, ExtensionHandler[]>;

export interface BoundExtensions {
	/** Handlers grouped by event, in manifest (registration) order. */
	hooks: BoundHooks;
	/** Extension-contributed tools by name (first registration wins on a name collision). */
	tools: Map<string, ToolDefinition>;
}

/**
 * Recover handler closures + contributed tools for the active manifest by re-running each NAMED factory
 * (inline factories — name `inline:N` — are skipped: their closures can't be recovered post-journal). Handlers
 * are merged per event in manifest order. Deterministic given the same manifest + registry, so it is
 * replay-stable.
 */
export async function bindManifest(
	manifest: ReadonlyArray<ExtensionManifestEntry>,
	getRegistered: (name: string) => ExtensionFactory | undefined,
): Promise<BoundExtensions> {
	const specs: Array<{ name: string; factory: ExtensionFactory }> = [];
	for (const entry of manifest) {
		const factory = getRegistered(entry.name);
		if (factory) specs.push({ name: entry.name, factory });
	}
	const { registrations } = await loadExtensions(specs);
	return mergeBound(manifest, registrations);
}

/**
 * Merge already-loaded registrations into hooks + tools in MANIFEST ORDER. Used by {@link bindManifest} and by
 * setup, which already holds the registrations from its load pass (so it doesn't re-run the factories).
 */
export function mergeBound(
	manifest: ReadonlyArray<ExtensionManifestEntry>,
	registrations: Map<string, ExtensionRegistration>,
): BoundExtensions {
	const hooks: BoundHooks = new Map();
	const tools = new Map<string, ToolDefinition>();
	for (const entry of manifest) {
		const reg = registrations.get(entry.name);
		if (!reg) continue;
		for (const [event, handlers] of reg.handlers) {
			const list = hooks.get(event) ?? [];
			list.push(...handlers);
			hooks.set(event, list);
		}
		for (const tool of reg.tools) {
			if (!tools.has(tool.name)) tools.set(tool.name, tool);
		}
	}
	return { hooks, tools };
}

/** A buffered `appendEntry` call, drained by the caller and persisted as a `custom` session entry. */
export interface BufferedEntry {
	customType: string;
	data?: unknown;
}

/**
 * An {@link ExtensionContext} whose `appendEntry` BUFFERS writes (the interface is sync but Convex persistence
 * is async). The caller fires hooks, then `drain()`s the buffer and persists the entries with deterministic
 * ids (idempotent on replay). Used for notify-class hooks (the only class allowed to persist).
 */
export function makeBufferedContext(usage?: unknown): { ctx: ExtensionContext; drain: () => BufferedEntry[] } {
	const buffer: BufferedEntry[] = [];
	const ctx: ExtensionContext = {
		appendEntry: (customType, data) => void buffer.push({ customType, data }),
		getContextUsage: () => usage,
	};
	return { ctx, drain: () => buffer.splice(0) };
}

function asResult(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Run notify-class handlers fire-and-forget; errors are swallowed (an observer must never break the run). */
export async function runNotifyHooks(
	hooks: BoundHooks,
	event: ExtensionEvent,
	ctx: ExtensionContext,
): Promise<void> {
	for (const handler of hooks.get(event.type) ?? []) {
		try {
			await handler(event, ctx);
		} catch {
			// observer error — ignore
		}
	}
}

/**
 * `context` hook: each handler may return `{ messages }` to replace the working message set (last-writer-wins).
 * Pure fold; the caller passes the messages built from frozen+persisted state, behind the replay guard.
 */
export async function applyContextHooks<M>(
	hooks: BoundHooks,
	messages: M[],
	ctx: ExtensionContext,
): Promise<M[]> {
	let current = messages;
	for (const handler of hooks.get("context") ?? []) {
		const result = asResult(await handler({ type: "context", messages: current } as ExtensionEvent, ctx));
		if (result && Array.isArray(result.messages)) current = result.messages as M[];
	}
	return current;
}

/** `before_agent_start` hook: each handler may return `{ systemPrompt }` to override the prompt (chained). */
export async function applyBeforeAgentStartHooks(
	hooks: BoundHooks,
	systemPrompt: string,
	ctx: ExtensionContext,
): Promise<string> {
	let current = systemPrompt;
	for (const handler of hooks.get("before_agent_start") ?? []) {
		const result = asResult(await handler({ type: "before_agent_start", systemPrompt: current } as ExtensionEvent, ctx));
		if (result && typeof result.systemPrompt === "string") current = result.systemPrompt;
	}
	return current;
}

export interface ToolCallDecision {
	args: Record<string, unknown>;
	blocked: boolean;
	reason?: string;
}

/**
 * `tool_call` hook: handlers may mutate the call args (returned `{ args }`) or block the call
 * (`{ block: true, reason? }`). Once blocked, later handlers still run but the call stays blocked.
 */
export async function applyToolCallHooks(
	hooks: BoundHooks,
	toolName: string,
	args: Record<string, unknown>,
	ctx: ExtensionContext,
): Promise<ToolCallDecision> {
	const decision: ToolCallDecision = { args, blocked: false };
	for (const handler of hooks.get("tool_call") ?? []) {
		const result = asResult(await handler({ type: "tool_call", toolName, input: decision.args } as ExtensionEvent, ctx));
		if (!result) continue;
		if (result.args && typeof result.args === "object") decision.args = result.args as Record<string, unknown>;
		if (result.block === true) {
			decision.blocked = true;
			if (typeof result.reason === "string") decision.reason = result.reason;
		}
	}
	return decision;
}

export interface ToolResultPatch {
	content?: unknown;
	details?: unknown;
	isError?: boolean;
}

export interface SessionBeforeCompactDecision {
	/** Cancel the compaction entirely (Cove makes it a NOOP, not a throw — design §8 #2). */
	cancel: boolean;
	/** Replace the generated summary with the extension's own (skips the model call). */
	replacementSummary?: string;
}

/**
 * `session_before_compact` hook: handlers may cancel the compaction (`{ cancel:true }` → noop) or replace its
 * summary (`{ compaction: { summary } }` → skip the model call). Cancel is sticky; replacement is last-wins.
 */
export async function applySessionBeforeCompactHooks(
	hooks: BoundHooks,
	event: { messagesToSummarize: number; tokensBefore: number },
	ctx: ExtensionContext,
): Promise<SessionBeforeCompactDecision> {
	const decision: SessionBeforeCompactDecision = { cancel: false };
	for (const handler of hooks.get("session_before_compact") ?? []) {
		const result = asResult(await handler({ type: "session_before_compact", ...event }, ctx));
		if (!result) continue;
		if (result.cancel === true) decision.cancel = true;
		const comp = asResult(result.compaction);
		if (comp && typeof comp.summary === "string") decision.replacementSummary = comp.summary;
	}
	return decision;
}

/** `tool_result` hook: handlers may return `{ content?, details?, isError? }` to patch the result (chained). */
export async function applyToolResultHooks(
	hooks: BoundHooks,
	toolName: string,
	result: ToolResultPatch,
	ctx: ExtensionContext,
): Promise<ToolResultPatch> {
	let current: ToolResultPatch = { ...result };
	for (const handler of hooks.get("tool_result") ?? []) {
		const patch = asResult(await handler({ type: "tool_result", toolName, ...current } as ExtensionEvent, ctx));
		if (!patch) continue;
		if ("content" in patch) current.content = patch.content;
		if ("details" in patch) current.details = patch.details;
		if (typeof patch.isError === "boolean") current.isError = patch.isError;
	}
	return current;
}
