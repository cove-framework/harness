// engine/runHandler (doc 04 "The loop") · @cove/runtime — the durable agent workflow. A thin wrapper that
// runs the pure orchestrator (loop.ts) with its journaled ports backed by step.run* checkpoints: setup →
// (llmStep → dispatchTools)* → finalize. Every step.run* is a journaled checkpoint, so a crash/redeploy
// resumes from the last committed step. No "use node" (the workflow handler is V8; the box-touching work is
// inside the llmStep/dispatchTools actions it invokes).

import { v } from "convex/values";
import { internal } from "../_generated/api";
import { ResultUnavailableError } from "../../src/runtime/errors.ts";
import { approvalEventName } from "./approvals.ts";
import { runAgentLoop } from "./loop.ts";
import { workflow } from "../workflow.ts";

export const agentRun = workflow.define({
	args: { requestId: v.id("agentRequests") },
	handler: async (step, { requestId }) => {
		// MCP discovery hop (G2.2): when the request declares mcpServers, a "use node" action discovers +
		// freezes their tools (a journaled checkpoint) BEFORE the freeze mutation, so setup stays a
		// deterministic mutation. Gated by a cheap query so non-MCP runs skip the node cold start.
		const mcpServers = await step.runQuery(internal.engine.requests.getMcpServers, { requestId });
		const discoveredMcp =
			mcpServers.length > 0
				? await step.runAction(internal.mcp.discover.run, { requestId })
				: [];
		const plan = await step.runMutation(internal.engine.setup.run, { requestId, discoveredMcp });

		try {
			await runAgentLoop(
				{
					maxSteps: plan.maxSteps,
					maxFollowUps: plan.maxFollowUps,
					hasResultSchema: plan.hasResultSchema,
				},
				{
					decode: (stepNumber) =>
						step.runAction(internal.engine.llmStep.run, { requestId, stepNumber }),
					dispatch: async (stepNumber) => {
						await step.runAction(internal.engine.dispatchTools.run, { requestId, stepNumber });
					},
					getOutcome: () => step.runQuery(internal.engine.steps.getOutcome, { requestId }),
					appendFollowUp: async (prompt) => {
						await step.runMutation(internal.engine.steps.appendFollowUp, {
							sessionId: plan.sessionId,
							requestId,
							prompt,
						});
					},
					finalize: async (input) => {
						await step.runMutation(internal.engine.finalize.run, {
							requestId,
							status: input.status,
							reason: input.reason,
							finalText: input.finalText,
							result: input.result,
							error: input.error,
						});
					},
					resolveApprovals: async (stepNumber, gatedCalls) => {
						await step.runMutation(internal.engine.approvals.park, {
							requestId,
							sessionId: plan.sessionId,
							calls: gatedCalls.map((c) => ({
								toolCallId: c.toolCallId,
								toolName: c.toolName,
								args: c.args,
							})),
						});
						for (const call of gatedCalls) {
							// Durable suspension: the run parks here until submitApproval emits the event.
							const decision = (await step.awaitEvent({
								name: approvalEventName(requestId, call.toolCallId),
							})) as { approved: boolean; editedArgs?: Record<string, unknown>; reason?: string };
							await step.runMutation(internal.engine.approvals.applyApproval, {
								requestId,
								stepNumber,
								toolCallId: call.toolCallId,
								toolName: call.toolName,
								args: call.args,
								decision,
							});
						}
					},
				},
			);
		} catch (error) {
			// A result-schema run that gave up / exhausted follow-ups already finalized the request as
			// failed; swallow the signal (don't retry) but still fall through to post the channel reply.
			if (!(error instanceof ResultUnavailableError)) throw error;
		}

		// Post-finalize channel reply (G2.3): a journaled, replay-idempotent step (the repliedAt stamp makes
		// a re-dispatch a no-op). No-op for native/HTTP runs (no replyContext). This is the ONLY engine touch
		// for channels and changes no loop semantics. Non-terminal (re-thrown) errors above never reach here.
		await step.runAction(internal.channels.reply.dispatch, { requestId });
	},
});
