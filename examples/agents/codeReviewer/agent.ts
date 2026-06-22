// New · @cove example — a small-but-real "codeReviewer" agent demonstrating G1–G5.
//   G1 (interface fidelity): createAgent + defineTool + (registry.ts) defineAgentRegistry.
//   G2 (realtime):           text_delta streamed via the reactive events query (convex/events/read.ts).
//   G3/G4 (durable/sandbox): the durable engine replays mid-turn (journaled steps); the agent shells via
//                            session.env when sandbox is configured (none here — pure review).
//   G5 (additive HITL):      `postReview` is an approval-gated tool — it parks an approval, then resumes
//                            on submitApproval. See APPROVAL_TOOLS + the README for where the gate is wired.
//
// HITL wiring note: `approvalTools` is NOT an AgentRuntimeConfig field (createAgent would reject it as an
// unknown runtime-config field — see src/runtime/agent-definition.ts AGENT_RUNTIME_FIELDS). The gate is a
// SUBMISSION-time concern: it lives on the request/plan (convex/schema.ts agentRequests.approvalTools,
// threaded by convex/invoke/admit.ts → setup.ts → llmStep.ts). This module exports the canonical
// `APPROVAL_TOOLS` list so the submit call (e.g. convex/dev.ts startPrompt or convex/invoke/submit.ts)
// can pass it through. The tool object itself is a plain defineTool; "gated" is the submission's choice.

import * as v from "valibot";
import { createAgent } from "../../../src/runtime/agent-definition.ts";
import { defineTool } from "../../../src/runtime/tool.ts";

/**
 * The HITL-gated tool. Listed in {@link APPROVAL_TOOLS}; a submission that passes that list parks an
 * approval before this `execute` runs (doc 08 §4.4). The parameters are a top-level valibot object
 * (required by every provider's tool-args contract) — `defineTool` converts it to JSON Schema once and
 * re-validates model-supplied args before `execute`.
 */
export const postReview = defineTool({
	name: "postReview",
	description:
		"Post the final code-review verdict for a pull request. Requires human approval before it is sent.",
	parameters: v.object({
		verdict: v.picklist(["approve", "request_changes", "comment"]),
		summary: v.pipe(v.string(), v.minLength(1, "summary must be non-empty")),
		blockingIssues: v.optional(v.array(v.string())),
	}),
	async execute(args): Promise<string> {
		// In a live deployment this would call the forge (GitHub/GitLab) review API. The example keeps it
		// pure + deterministic so the E2E asserts the post-approval resume without a network dependency.
		// `execute` returns a STRING (the tool result sent back to the model — doc tool-types.ts).
		const issues = args.blockingIssues ?? [];
		return JSON.stringify({
			posted: true,
			verdict: args.verdict,
			summary: args.summary,
			blockingIssueCount: issues.length,
		});
	},
});

/**
 * Tool names this agent expects a submission to gate behind human approval (G5). Pass this to the
 * submit call's `approvalTools` (convex/dev.ts startPrompt or convex/invoke/submit.ts submitPrompt).
 */
export const APPROVAL_TOOLS = ["postReview"] as const;

/** The skill catalog slug this agent activates (seeded from review-pr.skill.md via importSkill). */
export const REVIEW_SKILL_NAME = "review-pr";

/**
 * The created agent (G1). Returns an AgentRuntimeConfig — only the fields createAgent accepts:
 * model / instructions / tools / skills (also: profile, description, subagents, thinkingLevel,
 * compaction, durability, cwd, sandbox). The `review-pr` skill is referenced by name+description; it is
 * resolved at the call site from the catalog (getSkill), never the sandbox FS (doc 08 §3).
 */
export const codeReviewer = createAgent(() => ({
	model: "anthropic/claude-haiku-4-5",
	instructions: [
		"You are a meticulous senior code reviewer.",
		"Read the diff, reason about correctness, security, and clarity, then post exactly one review.",
		"Use the `review-pr` skill for the review checklist, and call `postReview` to deliver the verdict.",
		"`postReview` is human-gated: pause and let a reviewer approve before it is sent.",
	].join(" "),
	tools: [postReview],
	skills: [
		{
			name: REVIEW_SKILL_NAME,
			description: "Checklist + rubric for reviewing a pull request.",
		},
	],
}));
