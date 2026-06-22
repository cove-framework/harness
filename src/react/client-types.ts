// New · @cove/react
// The minimal STRUCTURAL reactive-client contract the react hooks/store depend on.
// The full `CoveReactiveClient` is defined+built by `@cove/sdk` (src/sdk/types.ts,
// src/sdk/client.ts — owned elsewhere); importing it here would create a react→sdk
// cycle, so we depend only on this minimal interface. `@cove/sdk`'s client is
// structurally assignable to it. `createReactiveClientFromConvex` builds an
// equivalent client off the ambient `ConvexReactClient` (the `useResolvedCoveClient`
// fallback) addressing the canonical cove backend functions by name via `anyApi`
// (decoupled from `convex/_generated`).

import type { ConvexReactClient } from "convex/react";
import { anyApi } from "convex/server";
import type { CoveEvent } from "../runtime/types.ts";
import type { AgentPromptImage } from "./ui-types.ts";

// Re-exported so the hooks/store import the prompt-image shape from the client contract.
export type { AgentPromptImage };

/** Result of admitting one agent prompt (cove drops flue's `streamUrl`/`offset`). */
export interface AgentSendResult {
	sessionId: string;
	requestId: string;
	submissionId: string;
}

/** Options for one direct-agent prompt. */
export interface AgentSendOptions {
	message: string;
	images?: AgentPromptImage[];
	instanceId?: string;
	harnessName?: string;
	sessionName?: string;
	model?: string;
}

/** Options for subscribing to a stream of events. */
export interface CoveStreamOptions {
	/** Resume from this seq (exclusive). Defaults to `-1` (from the start). */
	sinceSeq?: number;
}

/** Callback invoked with each batch of newly-observed (already seq-advanced) events. */
export type CoveEventsListener = (events: CoveEvent[]) => void;

/**
 * Minimal structural surface the react layer consumes. The `@cove/sdk`
 * `CoveReactiveClient` satisfies this (its `agents`/`runs` provide the same shapes).
 */
export interface CoveReactiveClient {
	agents: {
		/** Admit a prompt without waiting for the terminal result. */
		send(options: AgentSendOptions): Promise<AgentSendResult>;
	};
	/**
	 * Subscribe to a stream of `CoveEvent`s for `streamKey` (typically the agent
	 * `instanceId` or a `runId`). Returns an unsubscribe function. The listener
	 * receives only events with `seq` greater than the last delivered (the cursor is
	 * advanced internally); the reducer's own `recentEventIds` is the second dedup line.
	 */
	subscribeEvents(
		streamKey: string,
		listener: CoveEventsListener,
		options?: CoveStreamOptions,
	): () => void;
}

/** Shape returned by `events.listForStream` ({ events, nextSeq }). */
interface ListForStreamResult {
	events: (CoveEvent & { seq?: number })[];
	nextSeq: number;
}

/**
 * Build a {@link CoveReactiveClient} off an ambient `ConvexReactClient`, addressing the
 * canonical cove backend functions by name (`invoke.submitPrompt`, `events.listForStream`)
 * via `anyApi` so the react layer never imports `convex/_generated`.
 */
export function createReactiveClientFromConvex(convex: ConvexReactClient): CoveReactiveClient {
	const submitPrompt = anyApi.invoke.submitPrompt;
	const listForStream = anyApi.events.listForStream;

	return {
		agents: {
			async send(options) {
				const result = (await convex.mutation(submitPrompt, {
					prompt: options.message,
					model: options.model,
					instanceId: options.instanceId,
					harnessName: options.harnessName,
					sessionName: options.sessionName,
				})) as { sessionId: string; requestId: string; submissionId: string };
				return {
					sessionId: result.sessionId,
					requestId: result.requestId,
					submissionId: result.submissionId,
				};
			},
		},
		subscribeEvents(streamKey, listener, opts) {
			// Convex `onUpdate` re-delivers the WHOLE current result every reactive tick.
			// Track a local cursor and forward only events with `seq > cursor` (first dedup
			// line; the reducer's `recentEventIds` is the second). We resubscribe with the
			// advanced `sinceSeq` so the watched query window keeps shrinking server-side.
			let cancelled = false;
			let cursor = opts?.sinceSeq ?? -1;
			let unsubscribe: (() => void) | undefined;

			const subscribe = (sinceSeq: number) => {
				if (cancelled) return;
				const watch = convex.watchQuery(listForStream, { streamKey, sinceSeq });
				const handle = () => {
					if (cancelled) return;
					const result = watch.localQueryResult() as ListForStreamResult | undefined;
					if (!result) return;
					const fresh = result.events.filter(
						(event) => (event.seq ?? Number.POSITIVE_INFINITY) > cursor,
					);
					if (fresh.length === 0) return;
					cursor = Math.max(cursor, ...fresh.map((e) => e.seq ?? cursor));
					listener(fresh);
				};
				const off = watch.onUpdate(handle);
				// Deliver any already-available result synchronously (onUpdate only fires on change).
				handle();
				unsubscribe = off;
			};

			subscribe(cursor);
			return () => {
				cancelled = true;
				unsubscribe?.();
			};
		},
	};
}
