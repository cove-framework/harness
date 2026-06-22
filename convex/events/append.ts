// New (Convex backend) · @cove/runtime
// engine/events/append — the single durable write into the `events` table, called by "use node" engine
// actions via `internal.events.append.append` (emitFromAction). The decorate→redact→seq→fan-out logic
// lives in emit.ts (appendEvents) so the mutation-context emitters (setup/finalize) share one code path.
// `event` is validated as v.any(): the CoveEvent union is too large for a hand validator and the engine is
// the only caller (the consumer-facing read path re-types it as CoveEvent).

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";
import type { CoveEventInput } from "../../src/runtime/types.ts";
import { appendEvents } from "./emit.ts";

export const append = internalMutation({
	args: { event: v.any(), streamKeys: v.array(v.string()) },
	handler: async (ctx, { event, streamKeys }) => {
		await appendEvents(ctx.db, event as CoveEventInput, streamKeys);
	},
});
