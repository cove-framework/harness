// Ported from flue · @flue/sdk · packages/sdk/src/types.ts + packages/sdk/src/public/invoke.ts → @cove/sdk
//
// Type contract for the reactive consumer client (createCoveReactiveClient). The DS/HTTP
// transport shapes (streamUrl/offset) are dropped — events flow over Convex reactivity, not
// Durable Streams. RunStatus/RunRecord mirror the cove `runs` row (convex/schema.ts), NOT flue's
// workflow-only record. CoveEvent/AttachedAgentEvent/PromptUsage/IMAGE_DATA_OMITTED are re-exported
// from the runtime — never redefined here.

import type { FunctionReference } from "convex/server";
import { IMAGE_DATA_OMITTED } from "../runtime/event-image.ts";
import type {
	AttachedAgentEvent,
	CoveEvent,
	PromptResponse,
	PromptUsage,
} from "../runtime/types.ts";

// ── Runtime re-exports (canonical homes; do not redefine) ─────────────────────
export type { AttachedAgentEvent, CoveEvent, PromptResponse, PromptUsage };
export { IMAGE_DATA_OMITTED };

/**
 * Structural Convex client surface the reactive consumer client depends on. `convex/browser`'s
 * `ConvexClient` satisfies it directly (`mutation`/`query`/`onUpdate(ref, args, cb)`); the
 * event-stream test drives a hand-rolled fake. `onUpdate(ref, args, cb)` re-delivers the WHOLE
 * current query result on every reactive tick and returns an unsubscribe.
 *
 * NOTE (integration): the React `ConvexReactClient` exposes `watchQuery(ref,args).onUpdate(cb)` +
 * `localQueryResult()` rather than this flat shape — `@cove/react` already adapts it
 * (`createReactiveClientFromConvex`). For the standalone SDK client, pass a `convex/browser`
 * `ConvexClient` (or any value satisfying this interface).
 */
export interface CoveConvexClient {
	mutation(reference: any, args: Record<string, unknown>): Promise<any>;
	query(reference: any, args: Record<string, unknown>): Promise<any>;
	onUpdate(
		reference: any,
		args: Record<string, unknown>,
		callback: (result: any) => void,
		onError?: (error: Error) => void,
	): () => void;
}

/** Function references the reactive client calls (pass them from the app's generated `api`). */
export interface CoveReactiveApiRefs {
	/** `api.invoke.submitPrompt` — admits a prompt, returns `{ sessionId, requestId, submissionId }`. */
	submitPrompt: FunctionReference<"mutation">;
	/** `api.requests.get` — point-in-time request snapshot (watched to terminal by `agents.prompt`). */
	getRequest: FunctionReference<"query">;
	/** `api.runs.get` — run record (or the agentRequests-backed point-in-time fallback). */
	getRun: FunctionReference<"query">;
	/** `api.events.listForStream` — the reactive `{ events, nextSeq }` query feeding `runs.events`. */
	listForStream: FunctionReference<"query">;
}

/**
 * Options for {@link createCoveReactiveClient}. `convex` is any value satisfying
 * {@link CoveConvexClient} — a `convex/browser` `ConvexClient` directly, or `@cove/react`'s
 * `ConvexReactClient` adapter.
 */
export interface CreateCoveReactiveClientOptions {
	convex: CoveConvexClient;
	refs: CoveReactiveApiRefs;
}

// ── Stream / event-stream contract ────────────────────────────────────────────

/** Options for streaming cove events from an agent instance or workflow run. */
export interface CoveStreamOptions {
	/** Starting cursor. Yields only rows with `seq > sinceSeq`. Defaults to `-1` (full history). */
	sinceSeq?: number;
	/** Abort signal to cancel the stream. */
	signal?: AbortSignal;
}

/**
 * Async iterable of cove events backed by a Convex reactive subscription.
 *
 * Supports `for await...of` and explicit {@link cancel}. Breaking out of a `for await` loop
 * automatically unsubscribes the underlying `onUpdate`. The cursor advances only after a batch
 * is fully yielded (at-least-once): resuming from {@link sinceSeq} never skips an undelivered
 * `seq`; at worst it re-delivers events of the batch in flight when the checkpoint was taken.
 */
export interface CoveEventStream<T = CoveEvent> extends AsyncIterable<T> {
	/** Cancel the stream and unsubscribe the underlying reactive query. */
	cancel(reason?: unknown): void;
	/** Highest fully-yielded `seq + 1` — a safe resume point (see the at-least-once note above). */
	readonly sinceSeq: number;
}

// ── agents.send / agents.prompt result shapes ─────────────────────────────────

/** One image attached to an agent prompt. */
export interface AgentPromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

/** Options for one direct-agent prompt/send. */
export interface AgentPromptOptions {
	message: string;
	images?: AgentPromptImage[];
	signal?: AbortSignal;
}

/**
 * Result of admitting one agent prompt. All fields are server-provided by the submit mutation.
 * Drops flue's `streamUrl`/`offset` — events flow over Convex reactivity, keyed by `submissionId`.
 */
export interface AgentSendResult {
	sessionId: string;
	requestId: string;
	submissionId: string;
}

/** Result of one agent prompt that waited for the terminal result. */
export interface AgentPromptResult extends AgentSendResult {
	/** Terminal result of the prompt. */
	result: PromptResponse;
}

// ── runs (inspect surface) ────────────────────────────────────────────────────

/** Lifecycle status of a cove run. Mirrors the `runs` row (convex/schema.ts), NOT flue's. */
export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/** Persisted run record mirrored from the cove `runs` row (convex/schema.ts). */
export interface RunRecord {
	runId: string;
	agentName: string;
	instanceId: string;
	status: RunStatus;
	payload?: unknown;
	result?: unknown;
	error?: string;
	startedAt: number;
	updatedAt: number;
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** Structured error thrown by the reactive client. Message is always `[cove]`-prefixed. */
export class CoveApiError extends Error {
	/** Optional machine-readable error type. */
	readonly type?: string;
	/** Optional human-readable detail. */
	readonly details?: string;

	constructor(message: string, options?: { type?: string; details?: string; cause?: unknown }) {
		const prefixed = message.startsWith("[cove]") ? message : `[cove] ${message}`;
		super(prefixed, options?.cause !== undefined ? { cause: options.cause } : undefined);
		this.name = "CoveApiError";
		this.type = options?.type;
		this.details = options?.details;
	}
}

// ── The reactive consumer client ──────────────────────────────────────────────

/** Options for starting a workflow run (typed-but-throwing slot until G2.4). */
export interface WorkflowInvokeOptions {
	payload?: unknown;
	wait?: "result";
	signal?: AbortSignal;
}

/**
 * Reactive consumer client for a deployed cove application. Distinct from the runtime-facade
 * transport (`createCoveClient`/`createCoveTransport` in `index.ts`).
 */
export interface CoveReactiveClient {
	/** Direct interactions with persistent agent instances. */
	agents: {
		/** Starts one prompt without waiting for completion. */
		send(name: string, id: string, options: AgentPromptOptions): Promise<AgentSendResult>;
		/** Resolves the terminal result for one agent prompt (native `?wait=result` equivalent). */
		prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
	};
	/** Run inspection + reactive event streaming. */
	runs: {
		/** Retrieves one run record (or `null` when absent — see runs.ts fallback). */
		get(runId: string): Promise<RunRecord | null>;
		/** Reactive async-iterator of events for a streamKey / submissionId. */
		events(streamKey: string, options?: CoveStreamOptions): CoveEventStream;
	};
	/** Workflow runs — typed-but-throwing slot until G2.4 (D18). */
	workflows: {
		invoke(name: string, options?: WorkflowInvokeOptions): Promise<never>;
	};
}
