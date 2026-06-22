// New · @cove/react — reasonable optional `useCoveRun` per the spec.
// Folds the reactive `events` stream for a run/instance `streamKey` into a
// point-in-time run view: ordered events, log lines, terminal status, result, error.
// Self-contained — derives the view from the event stream rather than depending on the
// `@cove/sdk` `RunRecord`/`runs.get` shape (owned elsewhere), so `@cove/react` stays
// decoupled from `@cove/sdk`.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CoveEvent } from "../runtime/types.ts";
import type { CoveReactiveClient } from "./client-types.ts";
import { useResolvedCoveClient } from "./provider.tsx";

export type CoveRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface CoveRunLog {
	level: "info" | "warn" | "error";
	message: string;
	attributes?: Record<string, unknown>;
}

export interface UseCoveRunOptions {
	client?: CoveReactiveClient;
}

export interface UseCoveRunResult {
	events: CoveEvent[];
	logs: CoveRunLog[];
	status: CoveRunStatus;
	result: unknown;
	error: unknown;
}

interface RunFold {
	events: CoveEvent[];
	logs: CoveRunLog[];
	status: CoveRunStatus;
	result: unknown;
	error: unknown;
}

const emptyFold: RunFold = {
	events: [],
	logs: [],
	status: "running",
	result: undefined,
	error: undefined,
};

function foldEvent(fold: RunFold, event: CoveEvent): RunFold {
	const events = [...fold.events, event];
	switch (event.type) {
		case "log":
			return {
				...fold,
				events,
				logs: [
					...fold.logs,
					{ level: event.level, message: event.message, attributes: event.attributes },
				],
			};
		case "run_end":
			return {
				...fold,
				events,
				status: event.isError ? "failed" : "completed",
				result: event.result,
				error: event.error,
			};
		case "submission_settled":
			return {
				...fold,
				events,
				status: event.outcome === "failed" ? "failed" : fold.status,
				error: event.error ?? fold.error,
			};
		default:
			return { ...fold, events };
	}
}

/**
 * Subscribe to the reactive `events` stream for run/instance `streamKey` and fold it into
 * a `{ events, logs, status, result, error }` view. Re-renders on each delta flush.
 */
export function useCoveRun(
	streamKey: string | undefined,
	options: UseCoveRunOptions = {},
): UseCoveRunResult {
	const client = useResolvedCoveClient(options.client);
	const [fold, setFold] = useState<RunFold>(emptyFold);
	const foldRef = useRef<RunFold>(emptyFold);

	// Reset when the stream key changes.
	const key = useMemo(() => streamKey, [streamKey]);

	useEffect(() => {
		foldRef.current = emptyFold;
		setFold(emptyFold);
		if (!key) return;
		const unsubscribe = client.subscribeEvents(key, (incoming) => {
			let next = foldRef.current;
			for (const event of incoming) next = foldEvent(next, event);
			foldRef.current = next;
			setFold(next);
		});
		return unsubscribe;
	}, [client, key]);

	return {
		events: fold.events,
		logs: fold.logs,
		status: fold.status,
		result: fold.result,
		error: fold.error,
	};
}
