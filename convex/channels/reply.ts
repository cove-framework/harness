// New (Convex backend) · @cove/runtime — outbound reply dispatch (doc 06 P11). Fired by a journaled
// step.runAction AFTER the run terminalizes (never inside the ~3s ack window). Reads the terminal
// agentRequests row + its frozen replyContext, resolves the adapter, posts the result, stamps repliedAt.
// Guards make it a no-op for native/HTTP runs (no replyContext), non-terminal status (defensive), and a
// re-dispatch on workflow replay (repliedAt set) — so a reply is posted exactly once.

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { channelRegistry } from "./index.ts";
import type { ReplyContext, TerminalResult } from "./types.ts";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export const getForReply = internalQuery({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const r = await ctx.db.get(requestId);
		if (!r) return null;
		return {
			status: r.status,
			replyContext: r.replyContext ?? null,
			repliedAt: r.repliedAt,
			finalText: r.finalText,
			result: r.result,
			error: r.error,
		};
	},
});

export const markReplied = internalMutation({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		await ctx.db.patch(requestId, { repliedAt: Date.now() });
	},
});

export const dispatch = internalAction({
	args: { requestId: v.id("agentRequests") },
	handler: async (ctx, { requestId }) => {
		const row = await ctx.runQuery(internal.channels.reply.getForReply, { requestId });
		if (!row) return;
		if (!row.replyContext) return; // native/HTTP run — no channel to reply to
		if (row.repliedAt !== undefined) return; // already replied (replay double-post guard)
		if (!TERMINAL.has(row.status)) return; // defensive: only reply once terminal

		const replyContext = row.replyContext as ReplyContext;
		const adapter = channelRegistry[replyContext.provider];
		if (!adapter) return; // unknown provider — never crash the workflow

		const terminal: TerminalResult = {
			status: row.status as TerminalResult["status"],
			finalText: row.finalText,
			result: row.result,
			error: row.error,
		};
		await adapter.postReply(replyContext, terminal);
		await ctx.runMutation(internal.channels.reply.markReplied, { requestId });
	},
});
