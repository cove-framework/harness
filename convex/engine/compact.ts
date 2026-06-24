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
	combineSummaries,
	computeFileLists,
	DEFAULT_COMPACTION_SETTINGS,
	formatFileOperations,
	prepareCompaction,
	resolvePreviousCompaction,
	serializeConversation,
	SUMMARIZATION_PROMPT,
	SUMMARIZATION_SYSTEM_PROMPT,
	TURN_PREFIX_SUMMARIZATION_PROMPT,
	UPDATE_SUMMARIZATION_PROMPT,
} from "../../src/runtime/compaction.ts";
import type { CoveEventInput, PromptUsage } from "../../src/runtime/types.ts";
import { SessionHistory } from "../../src/runtime/session-history.ts";
// Side-effect: install the extension registry so bindManifest recovers session_before_compact hook closures.
import "../_cove/extensionResolver.ts";
import { getRegisteredExtension } from "../../src/runtime/extensions/registry.ts";
import { applySessionBeforeCompactHooks, bindManifest } from "../../src/runtime/extensions/apply.ts";
import type { ExtensionContext } from "../../src/runtime/extensions/types.ts";
import { emitFromAction } from "../events/emit.ts";
import { resolveModel } from "../providers/gateway.ts";
import { addUsage, type AiSdkUsage, emptyUsage, usageFromAiSdk } from "./usage.ts";

/** session_before_compact is content-mutation (pure) — a no-op appendEntry enforces it doesn't persist. */
const PURE_HOOK_CONTEXT: ExtensionContext = { appendEntry: () => {}, getContextUsage: () => undefined };

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
		// Incremental compaction (pragmatic-refactor Phase 4): translate the prior compaction's entry-id
		// boundary into the numeric index prepareCompaction expects, against THIS rebuilt context. When present
		// we summarize only the new slice with the UPDATE prompt (carrying the prior summary), not from scratch.
		const previous = resolvePreviousCompaction(
			contextEntries.map((e) => e.entry?.id),
			history.getLatestCompaction(),
		);
		const prep = prepareCompaction(messages, settings, previous);
		if (!prep) return finalize({ compacted: false, reason: "nothing older than the retained tail" }, false, messages.length, messages.length, 0);

		const firstKeptEntryId = contextEntries[prep.firstKeptIndex]?.entry?.id;
		if (!firstKeptEntryId) return finalize({ compacted: false, reason: "cut point has no persisted entry" }, false, messages.length, messages.length, 0);

		// session_before_compact (pragmatic-refactor Phase 5b): extensions may cancel the compaction (NOOP, not
		// a throw — design §8 #2) or replace its summary (skips the model call). Bound from the frozen manifest;
		// defensive (empty when the session has no frozen run-plan). Content-mutation → pure, no persist.
		let replacementSummary: string | undefined;
		if (args.requestId) {
			const manifest = await ctx.runQuery(internal.engine.requests.getExtensionManifest, {
				sessionId: args.sessionId,
			});
			if (manifest.length > 0) {
				const { hooks } = await bindManifest(manifest, getRegisteredExtension);
				if (hooks.has("session_before_compact")) {
					const decision = await applySessionBeforeCompactHooks(
						hooks,
						{ messagesToSummarize: prep.messagesToSummarize.length, tokensBefore: prep.tokensBefore },
						PURE_HOOK_CONTEXT,
					);
					if (decision.cancel) {
						return finalize({ compacted: false, reason: "cancelled by extension" }, false, messages.length, messages.length, 0);
					}
					replacementSummary = decision.replacementSummary;
				}
			}
		}

		const startedAt = Date.now();
		if (emitCtx.instanceId) {
			await emitFromAction(ctx, decorate({
				type: "compaction_start",
				reason: args.stepNumber === undefined ? "manual" : "threshold",
				estimatedTokens: prep.tokensBefore,
			}));
		}

		const { readFiles, modifiedFiles } = computeFileLists(prep.fileOps);
		let summary: string;
		let summarizationUsage: PromptUsage;
		if (replacementSummary !== undefined) {
			// An extension supplied the summary — skip the model call entirely (no summarization cost).
			summary = replacementSummary + formatFileOperations(readFiles, modifiedFiles);
			summarizationUsage = emptyUsage();
		} else {
			// History summary: UPDATE (incremental) when a prior summary exists, else a fresh checkpoint. A split
			// turn also summarizes the too-large turn PREFIX separately; both calls run in this one journaled action.
			const historyText = serializeConversation(prep.messagesToSummarize);
			const historyPrompt = prep.previousSummary
				? `<previous-summary>\n${prep.previousSummary}\n</previous-summary>\n\n<conversation>\n${historyText}\n</conversation>\n\n${UPDATE_SUMMARIZATION_PROMPT}`
				: `<conversation>\n${historyText}\n</conversation>\n\n${SUMMARIZATION_PROMPT}`;
			const [historyResult, prefixResult] = await Promise.all([
				generateText({ model: handle.model as LanguageModelV2, system: SUMMARIZATION_SYSTEM_PROMPT, prompt: historyPrompt }),
				prep.isSplitTurn
					? generateText({
							model: handle.model as LanguageModelV2,
							system: SUMMARIZATION_SYSTEM_PROMPT,
							prompt: `<conversation>\n${serializeConversation(prep.turnPrefixMessages)}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`,
						})
					: Promise.resolve(undefined),
			]);
			summary = combineSummaries(historyResult.text, prefixResult?.text) + formatFileOperations(readFiles, modifiedFiles);
			// Sum BOTH summarization calls' usage so split-turn cost is fully attributed (design §4.2 #12).
			const historyUsage = usageFromAiSdk(historyResult.usage as AiSdkUsage, handle);
			summarizationUsage = prefixResult
				? addUsage(historyUsage, usageFromAiSdk(prefixResult.usage as AiSdkUsage, handle))
				: historyUsage;
		}

		await ctx.runMutation(internal.sessions.store.appendCompactionEntry, {
			sessionId: args.sessionId,
			summary,
			firstKeptEntryId,
			tokensBefore: prep.tokensBefore,
			details: { readFiles, modifiedFiles },
			usage: summarizationUsage,
		});
		return finalize(
			{ compacted: true, firstKeptEntryId, tokensBefore: prep.tokensBefore },
			true,
			messages.length,
			messages.length - prep.messagesToSummarize.length - prep.turnPrefixMessages.length + 1,
			startedAt,
		);
	},
});
