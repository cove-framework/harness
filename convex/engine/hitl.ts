// New (Convex backend) · @cove/runtime — HITL gate decision logic (doc 04 "HITL" / 08 §4.4). Pure: given a
// step's tool calls + the approver's decision, partition the approval-gated calls and turn each decision
// into either an (optionally edited) call to dispatch or a rejection tool-result. The durable parking +
// step.awaitEvent gate is wired in runHandler/loop; this is the replay-safe decision core. Pure / V8-safe.

import type { EngineToolResult, ToolCallRecord } from "./types.ts";

/** The approver's decision for one gated tool call. */
export interface ApprovalDecision {
	approved: boolean;
	/** Approver-edited args (re-validated by the tool's normal execute-time validation at dispatch). */
	editedArgs?: Record<string, unknown>;
	reason?: string;
}

/** Split a step's tool calls into approval-gated (isHitl) and ungated. */
export function partitionGatedToolCalls(toolCalls: ToolCallRecord[]): {
	gated: ToolCallRecord[];
	ungated: ToolCallRecord[];
} {
	const gated: ToolCallRecord[] = [];
	const ungated: ToolCallRecord[] = [];
	for (const call of toolCalls) (call.isHitl ? gated : ungated).push(call);
	return { gated, ungated };
}

export type ApprovalOutcome =
	| { action: "dispatch"; call: ToolCallRecord }
	| { action: "reject"; result: EngineToolResult };

/**
 * Apply an approval decision to a gated call: approve (optionally with edited args) → dispatch the call;
 * reject → an error tool-result returned to the model (it self-corrects), never a crash.
 */
export function applyApprovalDecision(call: ToolCallRecord, decision: ApprovalDecision): ApprovalOutcome {
	if (!decision.approved) {
		const text = decision.reason
			? `[cove] tool call rejected by approver: ${decision.reason}`
			: "[cove] tool call rejected by approver.";
		return { action: "reject", result: { content: [{ type: "text", text }], isError: true } };
	}
	const call2 = decision.editedArgs ? { ...call, args: decision.editedArgs } : call;
	return { action: "dispatch", call: call2 };
}
