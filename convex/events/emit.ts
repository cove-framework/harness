// New (Convex backend) · @cove/runtime
// engine/events/emit — the engine-facing emitter. Computes the `streamKey` fan-out and writes the
// decorated + redacted CoveEvent into the `events` table. Two entry points because the engine emits
// from both contexts:
//   • emitFromMutation(ctx, input)  — setup/finalize are mutations → direct DB write (mutations can't runMutation).
//   • emitFromAction(ctx, input)    — llmStep/dispatchTools are "use node" actions → internal.events.append.append.
// Both converge on `appendEvents(db, …)`, so the decorate→redact→seq→insert logic lives in one place
// and the reactive read path (convex/events/read.ts) is the only reader.

import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import type { CoveEventInput } from "../../src/runtime/types.ts";
import { redactEventImages } from "./redact.ts";
import { nextSeq } from "./seq.ts";

/**
 * Fan-out keys for an event (doc schema `events.streamKey`): a workflow run is keyed by `runId`;
 * direct/dispatched agent activity is keyed by `instanceId` plus the per-session `${instanceId}:${session}`.
 */
export function computeStreamKeys(input: CoveEventInput): string[] {
	if (input.runId) return [input.runId];
	const keys: string[] = [];
	if (input.instanceId) {
		keys.push(input.instanceId);
		if (input.session) keys.push(`${input.instanceId}:${input.session}`);
	}
	return keys;
}

/**
 * Decorate → redact → allocate seq → insert one row per stream key. `eventIndex` is the per-context
 * ordinal (the primary stream's seq), shared across the fan-out so consumers dedup a re-delivered event
 * by a stable id. Single-writer-safe per stream (see seq.ts).
 */
export async function appendEvents(
	db: MutationCtx["db"],
	input: CoveEventInput,
	streamKeys: string[],
	now: () => number = Date.now,
): Promise<void> {
	if (streamKeys.length === 0) return;
	const redacted = redactEventImages(input);
	const timestamp = new Date(now()).toISOString();
	// Per-context ordinal: the primary (first) stream's next seq. Stable across the fan-out rows.
	const eventIndex = await nextSeq(db, streamKeys[0]);
	const data = { ...redacted, v: 1 as const, eventIndex, timestamp };
	for (const streamKey of streamKeys) {
		const seq = await nextSeq(db, streamKey);
		await db.insert("events", {
			streamKey,
			seq,
			eventIndex,
			type: input.type,
			runId: input.runId,
			instanceId: input.instanceId,
			submissionId: input.submissionId,
			session: input.session,
			data,
			createdAt: now(),
		});
	}
}

/** Emit from a mutation context (setup/finalize): direct DB write, no runMutation. */
export async function emitFromMutation(
	ctx: { db: MutationCtx["db"] },
	input: CoveEventInput,
): Promise<void> {
	await appendEvents(ctx.db, input, computeStreamKeys(input));
}

/** Emit from a "use node" action context (llmStep/dispatchTools): go through the append mutation. */
export async function emitFromAction(ctx: ActionCtx, input: CoveEventInput): Promise<void> {
	await ctx.runMutation(internal.events.append.append, {
		event: input,
		streamKeys: computeStreamKeys(input),
	});
}
