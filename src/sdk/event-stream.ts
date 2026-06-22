// Ported from flue · @flue/sdk · packages/sdk/src/public/stream.ts → @cove/sdk
//
// Serialized async-iterator over a Convex reactive query. Lifts flue's iterator contract
// verbatim — the `lastNext` serialization, `cancel()`/`return()` + abort handling, and the
// at-least-once cursor (advance `currentSeq` only AFTER a batch is fully yielded). The legacy
// Durable-Streams engine is REPLACED by `convex.onUpdate(listForStreamRef, …)`.
//
// CRITICAL: Convex `onUpdate` re-delivers the WHOLE current query result on every reactive
// tick — it is not a delta feed. We hold the latest delivered page and, in next(), diff its
// `events` against `currentSeq`, yielding only rows with `seq > currentSeq`. A second identical
// whole-result tick (same rows) therefore yields nothing new (seq dedup). The legacy
// live:false / tail / backstop branches are dropped: a reactive subscription is live by
// construction.

import type {
	CoveConvexClient,
	CoveEvent,
	CoveEventStream,
	CoveStreamOptions,
} from "./types.ts";

/** The `{ events, nextSeq }` page shape returned by `api.events.listForStream`. */
interface ListForStreamResult<T = CoveEvent> {
	events: readonly T[];
	nextSeq: number;
}

/** Options for wiring {@link createCoveEventStream} to a stream key (or submission id). */
export interface CreateCoveEventStreamOptions extends CoveStreamOptions {
	/** Structural Convex client. Only `onUpdate(ref, args, cb)` is used here. */
	convex: CoveConvexClient;
	/** Reactive query reference (`api.events.listForStream`). */
	listForStreamRef: unknown;
	/** Stream key to subscribe (`runId | instanceId | ${instanceId}:${session}`). */
	streamKey?: string;
	/** Submission id (events keyed by submission). Pass exactly one of streamKey/submissionId. */
	submissionId?: string;
}

/**
 * Creates a {@link CoveEventStream} that yields individual {@link CoveEvent} values from a
 * Convex reactive subscription, paging by `seq`.
 *
 * The subscription delivers the whole current page on every tick. We retain only the latest
 * page; `next()` slices the fresh tail (`seq > currentSeq`) from it and advances `currentSeq`
 * only after the whole fresh tail has been yielded (at-least-once). Re-delivered identical pages
 * yield nothing new because their rows are all `<= currentSeq` by then.
 */
export function createCoveEventStream<T = CoveEvent>(
	options: CreateCoveEventStreamOptions,
): CoveEventStream<T> {
	if (options.streamKey === undefined && options.submissionId === undefined) {
		throw new Error("[cove] createCoveEventStream: pass either streamKey or submissionId");
	}

	const abortController = new AbortController();

	// Link external signal to our controller. Store the handler so we can remove it when the
	// stream completes naturally (avoids retaining the closure scope on long-lived AbortSignals).
	let removeExternalAbortListener: (() => void) | undefined;
	if (options.signal) {
		const signal = options.signal;
		if (signal.aborted) {
			abortController.abort(signal.reason);
		} else {
			const onAbort = () => abortController.abort(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
			removeExternalAbortListener = () => signal.removeEventListener("abort", onAbort);
		}
	}

	// The at-least-once cursor. `currentSeq` advances per *delivered* batch — only once every
	// new event in the batch has been yielded — so resuming from it never skips an undelivered
	// `seq`. `onUpdate` re-delivers the whole result; we diff against this value.
	let currentSeq = options.sinceSeq ?? -1;

	let started = false;
	let unsubscribe: (() => void) | undefined;
	// The latest whole page delivered by onUpdate (re-delivered on every reactive tick).
	let latest: readonly T[] | undefined;
	// The fresh tail currently being yielded, sliced from `latest` once per drain cycle.
	let pending: { items: readonly T[]; next: number; maxSeq: number } | undefined;
	let notify: (() => void) | undefined;
	let deliveryDone = false;
	let streamFailure: { error: unknown } | undefined;

	/** Wakes a next() call waiting for the next tick, end, or cancellation. */
	const wake = () => {
		const resolve = notify;
		notify = undefined;
		resolve?.();
	};

	const cancel = (reason?: unknown) => {
		abortController.abort(reason);
		removeExternalAbortListener?.();
		unsubscribe?.();
		unsubscribe = undefined;
		wake();
	};

	/** Extract the `seq` of a delivered row. */
	const seqOf = (event: T): number => (event as unknown as { seq?: number }).seq ?? -1;

	const startConsuming = () => {
		const args: Record<string, unknown> = { sinceSeq: currentSeq };
		if (options.streamKey !== undefined) args.streamKey = options.streamKey;
		if (options.submissionId !== undefined) args.submissionId = options.submissionId;

		unsubscribe = options.convex.onUpdate(
			options.listForStreamRef,
			args,
			(result: ListForStreamResult<T> | undefined) => {
				if (abortController.signal.aborted) return;
				// Retain the whole re-delivered page; next() diffs it against currentSeq.
				latest = result?.events ?? [];
				wake();
			},
			(error: Error) => {
				streamFailure = { error };
				deliveryDone = true;
				wake();
			},
		);
	};

	/** Slice the fresh tail (`seq > currentSeq`) from the latest page, if any. */
	const takeFreshBatch = (): boolean => {
		if (!latest) return false;
		const fresh = latest.filter((event) => seqOf(event) > currentSeq);
		if (fresh.length === 0) return false;
		const maxSeq = fresh.reduce((max, event) => Math.max(max, seqOf(event)), currentSeq);
		pending = { items: fresh, next: 0, maxSeq };
		return true;
	};

	const nextResult = async (): Promise<IteratorResult<T>> => {
		while (true) {
			if (abortController.signal.aborted) {
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			if (!started) {
				started = true;
				try {
					startConsuming();
				} catch (err) {
					// Allow a later next() call to surface the same rejection again instead of
					// waiting forever for batches that will never arrive.
					started = false;
					removeExternalAbortListener?.();
					if (abortController.signal.aborted || isAbortError(err)) {
						return { value: undefined as T, done: true };
					}
					throw err;
				}
			}

			if (pending) {
				const value = pending.items[pending.next++] as T;
				if (pending.next >= pending.items.length) {
					// Advance the cursor only after the batch is fully yielded (at-least-once).
					currentSeq = pending.maxSeq;
					pending = undefined;
				}
				return { value, done: false };
			}

			// No batch in flight: try to slice a fresh tail from the latest delivered page.
			if (takeFreshBatch()) continue;

			if (deliveryDone) {
				if (streamFailure) {
					const { error } = streamFailure;
					streamFailure = undefined;
					removeExternalAbortListener?.();
					unsubscribe?.();
					unsubscribe = undefined;
					if (abortController.signal.aborted || isAbortError(error)) {
						return { value: undefined as T, done: true };
					}
					throw error;
				}
				removeExternalAbortListener?.();
				return { value: undefined as T, done: true };
			}

			// Wait for the next tick, stream end, or cancellation. A reactive subscription is live
			// by construction — there is no natural "up to date / stream closed" terminal; the
			// iterator ends only on cancel()/return()/abort or a subscription error.
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
	};

	// The async-iterator protocol permits calling next() again before the previous call settles,
	// but the body above is not reentrant: `notify` holds a single waiter, so a second concurrent
	// call would silently drop the first. Serialize calls so each runs only after the previous
	// settles.
	let lastNext: Promise<unknown> | undefined;
	const iterator: AsyncIterator<T> = {
		next(): Promise<IteratorResult<T>> {
			const result = lastNext ? lastNext.then(nextResult, nextResult) : nextResult();
			lastNext = result.catch(() => {});
			return result;
		},
		async return(): Promise<IteratorResult<T>> {
			cancel();
			return { value: undefined as T, done: true };
		},
	};

	return {
		cancel,
		get sinceSeq() {
			return currentSeq;
		},
		[Symbol.asyncIterator]() {
			return iterator;
		},
	};
}

function isAbortError(err: unknown): boolean {
	if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError")
		return true;
	if (err instanceof Error && err.name === "AbortError") return true;
	return false;
}
