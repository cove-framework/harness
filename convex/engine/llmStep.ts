"use node";
// engine/llmStep (doc 04) · @cove/runtime — one decode, streamed. Wires the pure decode core (decode.ts)
// to Convex: rebuild context from the entry tree (sessions.load → SessionHistory.buildContext →
// toModelMessages), rebuild the model-view tools from the frozen descriptors, and run the replay-guarded
// decode. "use node": imports resolveModel (AI SDK gateway) + the AI SDK via decode.ts.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { SessionHistory } from "../../src/runtime/session-history.ts";
import type { AgentMessage, Message } from "../../src/runtime/messages.ts";
// Side-effect: install the extension registry so getRegisteredExtension(name) binds named hooks in this isolate.
import "../_cove/extensionResolver.ts";
import { getRegisteredExtension } from "../../src/runtime/extensions/registry.ts";
import {
	applyBeforeAgentStartHooks,
	applyContextHooks,
	bindManifest,
	type BoundHooks,
	makeBufferedContext,
	runNotifyHooks,
} from "../../src/runtime/extensions/apply.ts";
import type { ExtensionContext } from "../../src/runtime/extensions/types.ts";
import { emitFromAction } from "../events/emit.ts";
import { resolveModel } from "../providers/gateway.ts";
import { toModelMessages } from "../providers/messages.ts";
import { buildModelView } from "./buildTools.ts";
import { type DecodeDeps, runDecode } from "./decode.ts";
import type { StepDecision } from "./types.ts";

/** Content-mutation hooks are PURE transforms — they must not persist. A no-op appendEntry enforces that here. */
const PURE_HOOK_CONTEXT: ExtensionContext = { appendEntry: () => {}, getContextUsage: () => undefined };

export const run = internalAction({
	args: { requestId: v.id("agentRequests"), stepNumber: v.number() },
	handler: async (ctx, { requestId, stepNumber }): Promise<StepDecision> => {
		const plan = await ctx.runQuery(internal.engine.requests.getRunPlanContext, { requestId });

		const handle = resolveModel(plan.model);
		if (!handle) throw new Error(`[cove] no model configured for request ${requestId}`);

		const data = await ctx.runQuery(internal.sessions.store.load, { sessionId: plan.sessionId });
		const history = SessionHistory.fromData(data);

		// Extension content-mutation hooks (pragmatic-refactor Phase 5b): bind the frozen manifest's named
		// extensions (re-run their registration-only factories to recover handler closures) and apply the
		// `before_agent_start` (system-prompt override) + `context` (message rewrite) hooks BEFORE the model
		// call. Pure folds in manifest order; their effect flows only into this live decode (the journaled step
		// output is what a replay reconstructs), so this is replay-safe. Inline-factory hooks aren't recoverable
		// here (skipped at bind). No extensions → zero overhead.
		let systemPrompt = plan.systemPrompt;
		let contextMessages = history.buildContext() as AgentMessage[];
		let boundHooks: BoundHooks | undefined;
		if (plan.extensions.length > 0) {
			boundHooks = (await bindManifest(plan.extensions, getRegisteredExtension)).hooks;
			systemPrompt = await applyBeforeAgentStartHooks(boundHooks, systemPrompt, PURE_HOOK_CONTEXT);
			contextMessages = await applyContextHooks(boundHooks, contextMessages, PURE_HOOK_CONTEXT);
		}

		const messages = toModelMessages(contextMessages as Message[], handle);
		const tools = buildModelView(plan.tools);
		const hitlToolNames = new Set(plan.approvalTools);

		// Per-turn correlation id + the event-emit closure (G2.1): decode emits the turn's events; this
		// closure stamps the request's stream-key fan-out fields (instanceId/submissionId/session) onto each
		// before writing through internal.events.append.append.
		const turnId = `${requestId}:${stepNumber}`;
		const emit = async (event: Parameters<NonNullable<DecodeDeps["emit"]>>[0]): Promise<void> => {
			await emitFromAction(ctx, {
				...event,
				instanceId: plan.instanceId,
				submissionId: plan.submissionId,
				session: plan.sessionName,
			});
		};

		// Frozen compaction settings (G2.5) → the decode's threshold gate. Disabled (false) / contextWindow 0
		// ⇒ undefined ⇒ shouldCompact stays false.
		const compaction =
			plan.compaction && plan.compaction.enabled
				? {
						settings: {
							enabled: true,
							reserveTokens: plan.compaction.reserveTokens,
							keepRecentTokens: plan.compaction.keepRecentTokens,
						},
						contextWindow: plan.compaction.contextWindow,
					}
				: undefined;

		const deps: DecodeDeps = {
			hitlToolNames,
			emit,
			compaction,
			loadStep: async () => {
				const row = await ctx.runQuery(internal.engine.steps.byRequestStep, { requestId, stepNumber });
				if (!row) return null;
				return {
					isFinalized: row.isFinalized,
					finishReason: row.finishReason,
					text: row.text,
					toolCalls: row.toolCalls,
					usage: row.usage, // G2.5: the replay path computes shouldCompact from the persisted usage
				};
			},
			insertStreaming: async () => {
				await ctx.runMutation(internal.engine.steps.insertStreaming, { requestId, stepNumber });
			},
			patch: async (p) => {
				await ctx.runMutation(internal.engine.steps.patchStreaming, {
					requestId,
					stepNumber,
					text: p.text,
					reasoning: p.reasoning,
				});
			},
			finalizeStep: async (f) => {
				await ctx.runMutation(internal.engine.steps.finalizeStep, {
					requestId,
					stepNumber,
					sessionId: plan.sessionId,
					finishReason: f.finishReason,
					text: f.text,
					reasoning: f.reasoning,
					toolCalls: f.toolCalls,
					responseMessages: f.responseMessages,
					usage: f.usage,
					model: f.model,
					durationMs: f.durationMs,
				});
			},
			finalizeOverflow: async (durationMs) => {
				await ctx.runMutation(internal.engine.steps.finalizeOverflowStep, {
					requestId,
					stepNumber,
					durationMs,
				});
			},
		};

		const decision = await runDecode({ handle, systemPrompt, messages, tools, turnId }, deps);

		// Notify hook `turn_end` (pragmatic-refactor Phase 5b): fire-and-forget after the decode. Any
		// appendEntry calls are persisted with deterministic ids (idempotent on a crash-replay). llmStep is a
		// journaled action, so this runs only on the live decode.
		if (boundHooks?.has("turn_end")) {
			const { ctx: notifyCtx, drain } = makeBufferedContext();
			await runNotifyHooks(boundHooks, { type: "turn_end", stepNumber, finishReason: decision.finishReason }, notifyCtx);
			const buffered = drain();
			if (buffered.length > 0) {
				await ctx.runMutation(internal.sessions.store.appendCustomEntries, {
					sessionId: plan.sessionId,
					entries: buffered.map((b, i) => ({
						entryId: `x-${requestId}-${stepNumber}-te-${i}`,
						customType: b.customType,
						data: b.data,
					})),
				});
			}
		}

		return decision;
	},
});
