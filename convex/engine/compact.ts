"use node";
// engine/compact (doc 04 "Compaction" / P12) · @cove/runtime — the compaction workflow step. Consumes the
// pure prepareCompaction (src/runtime/compaction.ts): rebuild context from the entry tree, find the cut
// point, summarize the older slice with a one-shot model call (gateway generateText), and append a
// CompactionEntry — after which SessionHistory.buildContextEntries() serves [summary + retained tail].
// Explicit session.compact() calls this directly; the loop's threshold auto-trigger (shouldCompact gate)
// wires the same action and is the small remaining wire. "use node": imports the AI SDK + the gateway.

import type { LanguageModelV2 } from "@ai-sdk/provider";
import { generateText } from "ai";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import { internalAction } from "../_generated/server";
import {
	computeFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	formatFileOperations,
	prepareCompaction,
	serializeConversation,
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
} from "../../src/runtime/compaction.ts";
import type { CoveEventInput } from "../../src/runtime/types.ts";
import { SessionHistory } from "../../src/runtime/session-history.ts";
import { emitFromAction } from "../events/emit.ts";
import { resolveModel } from "../providers/gateway.ts";

export const compact = internalAction({
	args: {
		sessionId: v.id("sessions"),
		model: v.optional(v.string()),
		keepRecentTokens: v.optional(v.number()),
		reserveTokens: v.optional(v.number()),
		// G2.5: the loop's compact step passes requestId/stepNumber for event context. session.compact()
		// passes finalizeOnComplete so the standalone kind:"compact" request terminalizes for awaitTerminal.
		requestId: v.optional(v.id("agentRequests")),
		stepNumber: v.optional(v.number()),
		finalizeOnComplete: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args,
	): Promise<{ compacted: boolean; firstKeptEntryId?: string; tokensBefore?: number; reason?: string }> => {
		const handle = resolveModel(args.model ?? "anthropic/claude-haiku-4-5");
		if (!handle) throw new Error("[cove] no model resolved for compaction");

		// Event-stream context (G2.5/G2.1): emit compaction_start/compaction so the OTel observer + UI see it.
		const emitCtx = await ctx.runQuery(internal.engine.requests.getEmitContext, {
			sessionId: args.sessionId,
			requestId: args.requestId,
		});
		const decorate = (event: CoveEventInput): CoveEventInput =>
			({
				...event,
				...(emitCtx.instanceId ? { instanceId: emitCtx.instanceId } : {}),
				...(emitCtx.submissionId ? { submissionId: emitCtx.submissionId } : {}),
				...(emitCtx.sessionName ? { session: emitCtx.sessionName } : {}),
			}) as CoveEventInput;
		const finalize = async (
			out: { compacted: boolean; firstKeptEntryId?: string; tokensBefore?: number; reason?: string },
			started: boolean,
			messagesBefore: number,
			messagesAfter: number,
			startedAt: number,
		) => {
			if (started && emitCtx.instanceId) {
				await emitFromAction(ctx, decorate({
					type: "compaction",
					messagesBefore,
					messagesAfter,
					durationMs: Date.now() - startedAt,
					isError: false,
				}));
			}
			// session.compact() (standalone kind:"compact" request) terminalizes so its CallHandle resolves.
			if (args.finalizeOnComplete && args.requestId) {
				await ctx.runMutation(internal.engine.finalize.run, {
					requestId: args.requestId,
					status: "completed",
					finalText: out.compacted ? "compacted" : (out.reason ?? "noop"),
				});
			}
			return out;
		};

		const data = await ctx.runQuery(internal.sessions.store.load, { sessionId: args.sessionId });
		const history = SessionHistory.fromData(data);
		const contextEntries = history.buildContextEntries();
		const messages = contextEntries.map((e) => e.message);

		const settings = {
			enabled: true,
			reserveTokens: args.reserveTokens ?? DEFAULT_COMPACTION_SETTINGS.reserveTokens,
			keepRecentTokens: args.keepRecentTokens ?? DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
		};
		const prep = prepareCompaction(messages, settings);
		if (!prep) return finalize({ compacted: false, reason: "nothing older than the retained tail" }, false, messages.length, messages.length, 0);

		const firstKeptEntryId = contextEntries[prep.firstKeptIndex]?.entry?.id;
		if (!firstKeptEntryId) return finalize({ compacted: false, reason: "cut point has no persisted entry" }, false, messages.length, messages.length, 0);

		const startedAt = Date.now();
		if (emitCtx.instanceId) {
			await emitFromAction(ctx, decorate({
				type: "compaction_start",
				reason: args.stepNumber === undefined ? "manual" : "threshold",
				estimatedTokens: prep.tokensBefore,
			}));
		}

		const conversationText = serializeConversation(prep.messagesToSummarize);
		const result = await generateText({
			model: handle.model as LanguageModelV2,
			system: SUMMARIZATION_SYSTEM_PROMPT,
			prompt: `<conversation>\n${conversationText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`,
		});

		const { readFiles, modifiedFiles } = computeFileLists(prep.fileOps);
		const summary = result.text + formatFileOperations(readFiles, modifiedFiles);

		await ctx.runMutation(internal.sessions.store.appendCompactionEntry, {
			sessionId: args.sessionId,
			summary,
			firstKeptEntryId,
			tokensBefore: prep.tokensBefore,
			details: { readFiles, modifiedFiles },
		});
		return finalize(
			{ compacted: true, firstKeptEntryId, tokensBefore: prep.tokensBefore },
			true,
			messages.length,
			messages.length - prep.messagesToSummarize.length + 1,
			startedAt,
		);
	},
});
