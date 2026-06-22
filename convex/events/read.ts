// New (Convex backend) · @cove/runtime
// engine/events/read — the reactive read path; `listForStream` IS the stream (flue's observe() substitute).
// A subscriber re-runs on every new/patched matching row, so native clients get the live ordered sequence
// with zero SSE. Each returned event carries its monotonic `seq` so the SDK's CoveEventStream can diff a
// whole-result re-delivery (Convex `onUpdate` re-sends the ENTIRE current result each tick) and yield only
// rows past its cursor — G2.1 §4.6 / Risks. HTTP/SDK callers page by `seq`; `nextSeq` is the next cursor.

import { v } from "convex/values";
import { query } from "../_generated/server";
import type { CoveEvent } from "../../src/runtime/types.ts";

const DEFAULT_LIMIT = 256;

/** A delivered event carries its stream cursor so a re-delivered whole result can be diffed by `seq`. */
type StreamedEvent = CoveEvent & { seq: number };

export const listForStream = query({
	args: {
		streamKey: v.string(),
		sinceSeq: v.optional(v.number()),
		limit: v.optional(v.number()),
	},
	handler: async (ctx, { streamKey, sinceSeq, limit }) => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_stream_and_seq", (q) =>
				q.eq("streamKey", streamKey).gt("seq", sinceSeq ?? -1),
			)
			.take(limit ?? DEFAULT_LIMIT);
		const last = rows.at(-1);
		return {
			events: rows.map((r): StreamedEvent => ({ ...(r.data as CoveEvent), seq: r.seq })),
			nextSeq: last ? last.seq + 1 : (sinceSeq ?? 0),
		};
	},
});

export const listForSubmission = query({
	args: { submissionId: v.string(), sinceSeq: v.optional(v.number()) },
	handler: async (ctx, { submissionId, sinceSeq }) => {
		const rows = await ctx.db
			.query("events")
			.withIndex("by_submission", (q) => q.eq("submissionId", submissionId))
			.collect();
		// A submission fans out across stream keys (instanceId + `${instanceId}:${session}`); dedup by the
		// shared per-context `eventIndex` and use it as the monotonic cursor so each event is seen once.
		const byIndex = new Map<number, (typeof rows)[number]>();
		for (const r of rows) if (!byIndex.has(r.eventIndex)) byIndex.set(r.eventIndex, r);
		const ordered = [...byIndex.values()]
			.filter((r) => r.eventIndex > (sinceSeq ?? -1))
			.sort((a, b) => a.eventIndex - b.eventIndex);
		const last = ordered.at(-1);
		return {
			events: ordered.map((r): StreamedEvent => ({ ...(r.data as CoveEvent), seq: r.eventIndex })),
			nextSeq: last ? last.eventIndex + 1 : (sinceSeq ?? 0),
		};
	},
});
