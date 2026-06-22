// New (Convex backend) · @cove/runtime
// engine/events/seq — monotonic per-stream sequence allocation. `seq` is the
// opaque cursor the SDK/HTTP callers page by; native clients use Convex
// reactivity. Single-writer-safe: writes to one `streamKey` are serialized by
// the per-session gate (P6) + the engine's single-writer loop, so read-then-+1
// never races on the same stream (doc 08 §4.6 / G2.1 Risks).

import type { QueryCtx } from "../_generated/server";

/** Next `seq` for `streamKey`: max existing seq on `by_stream_and_seq` + 1 (−1+1 = 0 for an empty stream). */
export async function nextSeq(db: QueryCtx["db"], streamKey: string): Promise<number> {
	const last = await db
		.query("events")
		.withIndex("by_stream_and_seq", (q) => q.eq("streamKey", streamKey))
		.order("desc")
		.first();
	return (last?.seq ?? -1) + 1;
}
