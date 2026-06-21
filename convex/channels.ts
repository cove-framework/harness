// New (Convex backend) · @cove/runtime — channel inbound helpers (doc 06 P11). markWebhookSeen is the
// idempotent dedup (per provider event id) shared by all channels — no separate inbound table; the meta kv
// is the dedup ledger. The per-channel signature-verify + payload mapping is pure (src/runtime/channels/*);
// the webhook route + submit live in http.ts. No "use node".

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Idempotent webhook dedup: record the event key once. Returns isNew=false for a replayed delivery. */
export const markWebhookSeen = internalMutation({
	args: { key: v.string() },
	handler: async (ctx, { key }): Promise<{ isNew: boolean }> => {
		const existing = await ctx.db
			.query("meta")
			.withIndex("by_key", (q) => q.eq("key", key))
			.unique();
		if (existing) return { isNew: false };
		await ctx.db.insert("meta", { key, value: { seenAt: Date.now() } });
		return { isNew: true };
	},
});
