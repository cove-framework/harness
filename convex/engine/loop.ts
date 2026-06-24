// Ported-pattern from flue · @flue/runtime · packages/runtime/src/session.ts (the agent turn loop) → @cove/runtime
// The durable agent loop's CONTROL FLOW: setup runs once, then (decode → dispatch)* until a terminal
// condition (doc 04 "The loop"). Extracted as a pure orchestrator over an injected RunLoopDeps port whose
// operations ARE the journaled workflow steps (step.runAction/runMutation/runQuery). On a workflow replay
// the orchestrator re-runs and each dep returns its cached journal result, so the same branch is taken and
// the stepNumber/followUps counters reconstruct deterministically — never re-derived from live state.
//
// Hardened contracts honored here:
//   - Step cap (doc 08 §4.9): while (stepNumber < maxSteps); at the cap → finalize failed/step_limit_exceeded.
//   - Result re-nudge & termination (doc 08 §4.10): for a result-schema run, the durable outcome
//     (computeResultOutcome over persisted rows) drives finished/gave_up/pending; gave_up and exhausted
//     follow-ups finalize failed and reject the CallHandle with ResultUnavailableError — never an
//     unvalidated resolve.
//
// Pure / V8-safe: no Convex, no AI SDK.

import { ResultUnavailableError } from "../../src/runtime/errors.ts";
import { buildResultFollowUpPrompt } from "./resultTools.ts";
import type { ResultOutcome } from "./resultTools.ts";
import type { StepDecision, ToolCallRecord } from "./types.ts";

/** Default context-overflow retry budget (pragmatic-refactor Phase 4b): pi-style "retry once after compaction". */
export const DEFAULT_OVERFLOW_RETRY_BUDGET = 1;

export interface LoopPlan {
	/** Defense-in-depth step ceiling (doc 08 §4.9, default 100). */
	maxSteps: number;
	/** Result-tool re-nudge budget (doc 08 §4.10, default 32). */
	maxFollowUps: number;
	/** Whether the run declares an output schema (result-shaped run). */
	hasResultSchema: boolean;
	/**
	 * Context-overflow compact-and-retry budget (pragmatic-refactor Phase 4b). The CONSUMED count is tracked
	 * loop-locally (reconstructed deterministically on replay, like followUps); this is the ceiling. Defaults
	 * to {@link DEFAULT_OVERFLOW_RETRY_BUDGET} when omitted.
	 */
	overflowRetryBudget?: number;
}

export interface FinalizeInput {
	status: "completed" | "failed";
	/** Terminal reason: step_limit_exceeded | result_followups_exhausted | gave_up (failed only). */
	reason?: string;
	finalText?: string;
	/** Validated structured result (result-schema completed run only). */
	result?: unknown;
	error?: string;
}

/** Journaled operations the loop drives — each is a workflow step.run* checkpoint. */
export interface RunLoopDeps {
	/** One decode (step.runAction → llmStep). Returns the step decision (replay-guarded). */
	decode(stepNumber: number): Promise<StepDecision>;
	/** Run the step's tool calls (step.runAction → dispatchTools). */
	dispatch(stepNumber: number, toolCalls: ToolCallRecord[]): Promise<void>;
	/** Durable result outcome from persisted tool-result rows (step.runQuery → getOutcome). */
	getOutcome(): Promise<ResultOutcome>;
	/** Append a re-nudge follow-up user turn (step.runAction → appendFollowUp). */
	appendFollowUp(prompt: string): Promise<void>;
	/** Terminalize the request (step.runMutation → finalize). */
	finalize(input: FinalizeInput): Promise<void>;
	/** HITL gate: park the approval-gated calls and await/apply their decisions before dispatch (doc 08 §4.4). */
	resolveApprovals?(stepNumber: number, gatedCalls: ToolCallRecord[]): Promise<void>;
	/** Threshold compaction (G2.5): a journaled step.runAction(compact). Called when decision.shouldCompact. */
	compact?(stepNumber: number): Promise<void>;
}

/**
 * Run the agent loop to a terminal state. Resolves when the request terminalizes `completed` or
 * `failed`; throws {@link ResultUnavailableError} when a result-schema run gives up or exhausts its
 * re-nudge budget (the CallHandle then rejects rather than resolving an unvalidated result).
 */
export async function runAgentLoop(plan: LoopPlan, deps: RunLoopDeps): Promise<void> {
	let stepNumber = 0;
	let followUps = 0;
	let overflowRetries = 0;
	const overflowRetryBudget = plan.overflowRetryBudget ?? DEFAULT_OVERFLOW_RETRY_BUDGET;

	while (stepNumber < plan.maxSteps) {
		const decision = await deps.decode(stepNumber);

		// Context-overflow recovery (pragmatic-refactor Phase 4b): the provider rejected the oversized request
		// (decode marked an overflow step — no session entry was appended). Compact, then advance to a FRESH
		// step that re-decodes the compacted history. The consumed count is loop-local (deterministic on
		// replay). Budget exhausted (or no compaction) → fail observably rather than loop.
		if (decision.overflow) {
			if (deps.compact && overflowRetries < overflowRetryBudget) {
				await deps.compact(stepNumber);
				overflowRetries++;
				stepNumber++;
				continue;
			}
			await deps.finalize({ status: "failed", reason: "context_overflow" });
			return;
		}

		if (decision.toolCalls.length === 0) {
			// No tool calls this step. A free-form run is done; a result-schema run that stopped without
			// a terminal tool is re-nudged (bounded by maxFollowUps).
			if (!plan.hasResultSchema) {
				await deps.finalize({ status: "completed", finalText: decision.text });
				return;
			}
			const settled = await settleResultRun(deps, decision.text);
			if (settled) return;
			if (followUps >= plan.maxFollowUps) {
				await deps.finalize({ status: "failed", reason: "result_followups_exhausted" });
				throw new ResultUnavailableError({ reason: "result_followups_exhausted" });
			}
			await deps.appendFollowUp(buildResultFollowUpPrompt());
			followUps++;
			stepNumber++;
			continue;
		}

		// HITL gate (doc 08 §4.4): park approval-gated calls and await their decisions before dispatch. A
		// rejected call gets its tool-result written here, so dispatch (which skips already-resulted calls)
		// runs only the approved + ungated set.
		const gated = decision.toolCalls.filter((c) => c.isHitl);
		if (gated.length > 0 && deps.resolveApprovals) {
			await deps.resolveApprovals(stepNumber, gated);
		}
		await deps.dispatch(stepNumber, decision.toolCalls);

		// A result-schema run terminates as soon as a finish/give_up tool fired this batch.
		if (plan.hasResultSchema) {
			const settled = await settleResultRun(deps, decision.text);
			if (settled) return;
		}

		// Threshold compaction (G2.5): the step's persisted usage crossed the window − reserve. Compact (a
		// journaled step) BEFORE the next decode, which then reads the compacted [summary + tail] history. No
		// retry (threshold mode). The compact step is replay-deterministic, so a mid-loop replay re-yields the
		// journaled summary with no second summarization call (doc 08 §4.1).
		if (decision.shouldCompact && deps.compact) await deps.compact(stepNumber);

		stepNumber++;
	}

	// Step ceiling reached — observable failure, not a silent stop (doc 08 §4.9).
	await deps.finalize({ status: "failed", reason: "step_limit_exceeded" });
}

/**
 * Consult the durable result outcome and terminalize if it is terminal. Returns true when the run is
 * settled (the caller should stop), false when still pending. Throws on `gave_up` (after finalizing
 * failed) so the CallHandle rejects with ResultUnavailableError.
 */
async function settleResultRun(deps: RunLoopDeps, assistantText: string): Promise<boolean> {
	const outcome = await deps.getOutcome();
	if (outcome.type === "finished") {
		await deps.finalize({ status: "completed", result: outcome.value, finalText: assistantText });
		return true;
	}
	if (outcome.type === "gave_up") {
		await deps.finalize({ status: "failed", reason: "gave_up", error: outcome.reason });
		throw new ResultUnavailableError({ reason: outcome.reason, assistantText });
	}
	return false;
}
