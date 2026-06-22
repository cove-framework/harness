"use node";
// engine/llmStep (doc 04) · @cove/runtime — one decode, streamed. Wires the pure decode core (decode.ts)
// to Convex: rebuild context from the entry tree (sessions.load → SessionHistory.buildContext →
// toModelMessages), rebuild the model-view tools from the frozen descriptors, and run the replay-guarded
// decode. "use node": imports resolveModel (AI SDK gateway) + the AI SDK via decode.ts.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { SessionHistory } from "../../src/runtime/session-history.ts";
import type { Message } from "../../src/runtime/messages.ts";
import { emitFromAction } from "../events/emit.ts";
import { resolveModel } from "../providers/gateway.ts";
import { toModelMessages } from "../providers/messages.ts";
import { buildModelView } from "./buildTools.ts";
import { type DecodeDeps, runDecode } from "./decode.ts";
import type { StepDecision } from "./types.ts";

export const run = internalAction({
	args: { requestId: v.id("agentRequests"), stepNumber: v.number() },
	handler: async (ctx, { requestId, stepNumber }): Promise<StepDecision> => {
		const plan = await ctx.runQuery(internal.engine.requests.getPlanContext, { requestId });

		const handle = resolveModel(plan.model);
		if (!handle) throw new Error(`[cove] no model configured for request ${requestId}`);

		const data = await ctx.runQuery(internal.sessions.store.load, { sessionId: plan.sessionId });
		const history = SessionHistory.fromData(data);
		const messages = toModelMessages(history.buildContext() as Message[], handle);
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

		const deps: DecodeDeps = {
			hitlToolNames,
			emit,
			loadStep: async () => {
				const row = await ctx.runQuery(internal.engine.steps.byRequestStep, { requestId, stepNumber });
				if (!row) return null;
				return {
					isFinalized: row.isFinalized,
					finishReason: row.finishReason,
					text: row.text,
					toolCalls: row.toolCalls,
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
		};

		return runDecode(
			{ handle, systemPrompt: plan.systemPrompt, messages, tools, turnId },
			deps,
		);
	},
});
