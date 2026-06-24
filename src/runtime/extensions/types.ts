// New (Convex backend) · @cove/runtime — extension contract (pragmatic-refactor Phase 5).
//
// Ports pi's `(cove) => void` extension factory + `on(event, handler)` hook surface (pi ·
// coding-agent/src/core/extensions/types.ts), adapted to Cove's durable @convex-dev/workflow model. The
// hook set is partitioned into three DETERMINISM CLASSES by where a hook can legally run under journal replay:
//
//   • registration  — run ONCE at load (pure data collection): registerTool, registerSystemPromptFragment,
//                      on("setup"). Output is serialized into the frozen runPlan manifest.
//   • notify         — fire-and-forget, any boundary, skippable on replay (observe only; must NOT feed back
//                      into journaled inputs): agent_start/agent_end/turn_*, tool_execution_*, session_compact…
//   • content-mutation — run BEHIND the runDecode/loadStep replay guard as PURE fns of (frozen plan +
//                      persisted step inputs + event payload): context, before_provider_request, tool_call,
//                      tool_result, before_agent_start, message_end, session_before_compact. (Wired in 5b.)
//
// Pure / V8-safe: imports only the tool type. NEVER imports types.ts (so types.ts can re-export ExtensionFactory
// without a cycle) or the AI SDK.

import type { ToolDefinition } from "../tool-types.ts";

/** Registration-class hooks (run once at load). */
export type RegistrationEventName = "setup";

/** Notify-class hooks (fire-and-forget, skippable on replay). */
export type NotifyEventName =
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "tool_execution_start"
	| "tool_execution_end"
	| "session_compact"
	| "model_select";

/** Content-mutation-class hooks (behind the replay guard; pure fns). Wired in Phase 5b. */
export type ContentMutationEventName =
	| "context"
	| "before_provider_request"
	| "before_agent_start"
	| "message_end"
	| "tool_call"
	| "tool_result"
	| "session_before_compact";

export type ExtensionEventName = RegistrationEventName | NotifyEventName | ContentMutationEventName;

/** Determinism class of an event — the runner/binder uses this to decide where a hook may run. */
export function eventClass(event: ExtensionEventName): "registration" | "notify" | "content-mutation" {
	if (event === "setup") return "registration";
	if (
		event === "context" ||
		event === "before_provider_request" ||
		event === "before_agent_start" ||
		event === "message_end" ||
		event === "tool_call" ||
		event === "tool_result" ||
		event === "session_before_compact"
	) {
		return "content-mutation";
	}
	return "notify";
}

/** Event payload delivered to a handler. The concrete shape varies per event; carries at least its `type`. */
export interface ExtensionEvent {
	type: ExtensionEventName;
	[key: string]: unknown;
}

/**
 * Action-capable surface available ONLY inside a handler (never in the factory body — porting pi's
 * two-phase throwing-stub guarantee as a type-level guarantee: action methods are simply absent from the
 * registration API). `appendEntry` writes a persisted `custom` session entry (state, NOT sent to the LLM),
 * idempotent by a deterministic key.
 */
export interface ExtensionContext {
	appendEntry(customType: string, data?: unknown): void;
	/** Frozen per-step context usage when available (typed loosely to avoid a types.ts import cycle). */
	getContextUsage(): unknown;
}

export type ExtensionHandler = (
	event: ExtensionEvent,
	ctx: ExtensionContext,
) => unknown | void | Promise<unknown | void>;

/**
 * Registration-only API passed to the factory at load. Action methods (appendEntry, etc.) are deliberately
 * absent — they exist only on {@link ExtensionContext} inside a handler — so a factory body cannot perform
 * side effects, which is what makes re-instantiating a factory per isolate (to recover handler closures) safe.
 */
export interface ExtensionRegistrationAPI {
	/** Contribute a model-callable tool. Its descriptor is frozen; its execute closure is recovered by name. */
	registerTool(tool: ToolDefinition): void;
	/** Contribute a fragment composed into the frozen system prompt at setup. */
	registerSystemPromptFragment(fragment: string): void;
	/** Subscribe a handler to an event. Multiple handlers per event run in registration order. */
	on(event: ExtensionEventName, handler: ExtensionHandler): void;
}

/** A user-authored extension: a factory that wires registrations + hooks against the registration API. */
export type ExtensionFactory = (cove: ExtensionRegistrationAPI) => void | Promise<void>;

/** What one factory contributed when instantiated — the LIVE form (tools + fragments + handler closures). */
export interface ExtensionRegistration {
	tools: ToolDefinition[];
	systemPromptFragments: string[];
	handlers: Map<ExtensionEventName, ExtensionHandler[]>;
}

/**
 * The serialized, DATA-ONLY manifest entry frozen into `runPlan.extensions` (no closures). Replay reads this
 * stable, order-stable view; handler closures are recovered at bind time by re-running the named factory.
 */
export interface ExtensionManifestEntry {
	name: string;
	/** Tool names this extension contributed (closures recovered via the tool registry). */
	tools: string[];
	/** System-prompt fragments this extension contributed (composed at setup). */
	systemPromptFragments: string[];
	/** Subscribed event names in registration order (makes the hook chain order-stable across isolates). */
	events: ExtensionEventName[];
}
