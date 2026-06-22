// New (Convex backend) · @cove/runtime — shared channel dedup (doc 06 P11 / D14). markWebhookSeen is the
// idempotent per-(provider,eventId) ledger over the `meta` by_key index — no separate inbound table. The
// dedup insert runs BEFORE submitPrompt, so a replayed delivery never spawns a second run. Promoted from the
// former convex/channels.ts (Slack's slackDedupKey generalized to every channel). No "use node".

import { v } from "convex/values";
import { internalMutation } from "../_generated/server";

/** Provider-scoped dedup key for an inbound event. */
export function dedupKey(provider: string, eventId: string): string {
	return `webhook:${provider}:${eventId}`;
}

/** Idempotent webhook dedup: record the key once. Returns isNew=false for a replayed delivery. */
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
