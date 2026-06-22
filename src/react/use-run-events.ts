// Ported from flue · @flue/react · packages/react/src/use-agent.ts (split) → @cove/react
// One half of flue's `useFlueAgent` split: the EVENTS side. Owns the `AgentStore`
// (memoized by streamKey + client), starts/disposes the reactive subscription in a
// `useEffect`, and exposes the assembled `UIMessage[]` (+ status/error) via
// `useSyncExternalStore`. Mirrors flue's useMemo-keyed-store + useEffect + uSES shape;
// drops the DS reconnect machinery (Convex reactivity reconnects).
//
// NOTE: `streamKey` is the events fan-out key — the agent `instanceId` (or a `runId`),
// NOT the `agentRequests` id. The spec calls this `useRunEvents(requestId)`; in cove the
// reactive `events` stream is keyed by `instanceId`/`runId` (schema.ts `streamKey`), so
// callers pass the instance/run stream key. The reducer correlates per-submission by the
// event payload's `submissionId`/`turnId`.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { AgentSnapshot } from "./agent-reducer.ts";
import { emptyAgentState } from "./agent-reducer.ts";
import { AgentStore } from "./agent-store.ts";
import type { CoveReactiveClient } from "./client-types.ts";
import { useResolvedCoveClient } from "./provider.tsx";

const emptySnapshot: AgentSnapshot = {
	messages: emptyAgentState.messages,
	status: "idle",
	error: undefined,
};
const emptySubscribe = () => () => {};

export interface UseRunEventsOptions {
	/** Explicit reactive client (otherwise resolved from provider/ambient). */
	client?: CoveReactiveClient;
}

export interface UseRunEventsResult extends AgentSnapshot {
	/** The live `AgentStore` (exposes `sendMessage`), or `undefined` without a stream key. */
	store: AgentStore | undefined;
}

/**
 * Subscribe to the reactive `events` stream for `streamKey` and assemble it into a live
 * `UIMessage[]`. Re-renders on each batched delta flush. Returns `{ messages, status,
 * error, store }`.
 */
export function useRunEvents(
	streamKey: string | undefined,
	options: UseRunEventsOptions = {},
): UseRunEventsResult {
	const client = useResolvedCoveClient(options.client);
	const store = useMemo(
		() => (streamKey ? new AgentStore(client, streamKey) : undefined),
		[client, streamKey],
	);
	useEffect(() => {
		store?.start();
		return () => store?.dispose();
	}, [store]);
	const snapshot = useSyncExternalStore(
		store?.subscribe ?? emptySubscribe,
		store?.getSnapshot ?? (() => emptySnapshot),
		() => emptySnapshot,
	);
	return { ...snapshot, store };
}
