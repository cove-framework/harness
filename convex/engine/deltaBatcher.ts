// New (Convex backend) · @cove/runtime
// Pattern source: doc 04 "Delta batching" + doc 08 §4.6 (streaming commit & subscription semantics).
// No flue equivalent — flue streamed per-token deltas over Durable Streams; cove coalesces token deltas
// before patching `agentRequestSteps` so a per-token mutation storm never overwhelms Convex throughput.
//
// The batcher emits *deltas since the last flush* (not the cumulative text): `patchStreaming` appends
// them onto the step row in place, so the coalesced text accumulates server-side and a late subscriber
// reading the row sees the current text in-position (doc 08 §4.6). The flush sink + clock are injected,
// so the cadence is unit-tested deterministically.
//
// Pure / V8-safe: no Convex, no AI SDK.

/** A coalesced patch: the text/reasoning appended since the previous flush. */
export interface DeltaPatch {
	text?: string;
	reasoning?: string;
}

/** Production cadence (doc 08 §4.6). Configurable; set the final value from the P4 throughput test. */
export const DELTA_BATCH_CHARS = 480;
export const DELTA_BATCH_MS = 400;

export interface DeltaBatcherOptions {
	/** Flush once this many buffered chars accumulate. Defaults to {@link DELTA_BATCH_CHARS}. */
	maxChars?: number;
	/** Flush once this many ms elapse since the last flush. Defaults to {@link DELTA_BATCH_MS}. */
	maxMs?: number;
	/** Injected monotonic clock (ms). Defaults to `Date.now`; tests pass a controllable clock. */
	now?: () => number;
}

/**
 * Coalesces streamed text/reasoning deltas and flushes on the *looser* of the
 * char or time threshold. Each `text()`/`reasoning()` is awaited by the decode
 * loop, so flushes never interleave; `flush()` resets the buffer **before**
 * awaiting the sink, so a delta arriving mid-flush lands in the next batch.
 */
export class DeltaBatcher {
	private textBuf = "";
	private reasoningBuf = "";
	private pendingChars = 0;
	private lastFlush: number;
	private readonly maxChars: number;
	private readonly maxMs: number;
	private readonly now: () => number;

	constructor(
		private readonly sink: (patch: DeltaPatch) => Promise<void>,
		options: DeltaBatcherOptions = {},
	) {
		this.maxChars = options.maxChars ?? DELTA_BATCH_CHARS;
		this.maxMs = options.maxMs ?? DELTA_BATCH_MS;
		this.now = options.now ?? Date.now;
		this.lastFlush = this.now();
	}

	/** Buffer an assistant text delta; flushes when a threshold is crossed. */
	text(delta: string): Promise<void> {
		this.textBuf += delta;
		this.pendingChars += delta.length;
		return this.maybeFlush();
	}

	/** Buffer a reasoning/thinking delta; flushes when a threshold is crossed. */
	reasoning(delta: string): Promise<void> {
		this.reasoningBuf += delta;
		this.pendingChars += delta.length;
		return this.maybeFlush();
	}

	private maybeFlush(): Promise<void> {
		if (this.pendingChars >= this.maxChars || this.now() - this.lastFlush >= this.maxMs) {
			return this.flush();
		}
		return Promise.resolve();
	}

	/**
	 * Commit any buffered deltas through the sink. Always advances the flush clock
	 * (so an empty flush still resets the time window). Resets the buffer before
	 * awaiting the sink so concurrent deltas accumulate into the next batch.
	 */
	async flush(): Promise<void> {
		if (this.textBuf === "" && this.reasoningBuf === "") {
			this.lastFlush = this.now();
			return;
		}
		const patch: DeltaPatch = {};
		if (this.textBuf !== "") patch.text = this.textBuf;
		if (this.reasoningBuf !== "") patch.reasoning = this.reasoningBuf;
		this.textBuf = "";
		this.reasoningBuf = "";
		this.pendingChars = 0;
		this.lastFlush = this.now();
		await this.sink(patch);
	}
}
