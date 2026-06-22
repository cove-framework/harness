// New · @cove example — deterministic E2E for the codeReviewer sample.
//
// convex-test is NOT installed in this environment, so this asserts only the DETERMINISTIC, PURE
// portions: the agent / registry / tool / skill construct + validate, the HITL gate list, and the
// SKILL.md frontmatter parse. The full G1–G5 live path (mock model + convex-test, or `convex run`) is
// documented in the README and sketched in the comment at the bottom of this file.
//
// Node env.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineAgentRegistry } from "../../../../convex/agentRegistry.ts";
import { parseSkillMarkdown } from "../../../../src/runtime/skill-frontmatter.ts";
import { APPROVAL_TOOLS, REVIEW_SKILL_NAME, codeReviewer, postReview } from "../agent.ts";
import { registry } from "../registry.ts";

describe("codeReviewer sample — deterministic constructs (G1)", () => {
	it("createAgent produces a branded CreatedAgent", () => {
		expect(codeReviewer.__coveCreatedAgent).toBe(true);
		expect(typeof codeReviewer.initialize).toBe("function");
	});

	it("the initializer returns a valid AgentRuntimeConfig", async () => {
		const config = await codeReviewer.initialize({} as never);
		expect(config.model).toBe("anthropic/claude-haiku-4-5");
		expect(config.tools).toContain(postReview);
		expect(config.skills?.[0]?.name).toBe(REVIEW_SKILL_NAME);
		// approvalTools is NOT a runtime-config field — confirm the initializer never smuggled it in
		// (it would otherwise throw "unknown runtime config field" — see agent-definition.ts).
		expect((config as Record<string, unknown>).approvalTools).toBeUndefined();
	});

	it("postReview is a normalized tool definition", () => {
		expect(postReview.name).toBe("postReview");
		expect(typeof postReview.description).toBe("string");
		expect(postReview.description.length).toBeGreaterThan(0);
		// defineTool converts the valibot schema to plain JSON Schema (an object schema).
		expect(postReview.parameters).toBeTypeOf("object");
		expect((postReview.parameters as { type?: string }).type).toBe("object");
		expect(typeof postReview.execute).toBe("function");
	});

	it("postReview.execute validates args and returns a deterministic result string", async () => {
		const raw = await postReview.execute(
			{ verdict: "request_changes", summary: "Unvalidated path join.", blockingIssues: ["fileServer.ts:12"] },
			undefined,
		);
		expect(typeof raw).toBe("string");
		const result = JSON.parse(raw) as { posted: boolean; verdict: string; blockingIssueCount: number };
		expect(result.posted).toBe(true);
		expect(result.verdict).toBe("request_changes");
		expect(result.blockingIssueCount).toBe(1);
	});

	it("postReview rejects invalid args via the wrapped valibot validation", async () => {
		await expect(
			postReview.execute({ verdict: "nope", summary: "" } as never, undefined),
		).rejects.toThrow();
	});
});

describe("codeReviewer registry (G1) — defineAgentRegistry validates", () => {
	it("registers codeReviewer by name with the createAgent brand", () => {
		expect(registry.names).toEqual(["codeReviewer"]);
		expect(registry.has("codeReviewer")).toBe(true);
		expect(registry.get("codeReviewer")).toBe(codeReviewer);
	});

	it("a fresh defineAgentRegistry({ codeReviewer }) validates the brand + name", () => {
		const fresh = defineAgentRegistry({ codeReviewer });
		expect(fresh.listAgents()).toEqual([{ name: "codeReviewer" }]);
	});
});

describe("codeReviewer HITL gate (G5)", () => {
	it("postReview is the gated tool in APPROVAL_TOOLS", () => {
		expect(APPROVAL_TOOLS).toContain("postReview");
		// the gate list references real tool names declared on the agent
		expect(APPROVAL_TOOLS.every((name) => name === postReview.name)).toBe(true);
	});
});

describe("review-pr skill (P10) — frontmatter parses via parseSkillMarkdown", () => {
	const skillPath = fileURLToPath(new URL("../review-pr.skill.md", import.meta.url));
	const content = readFileSync(skillPath, "utf8");

	it("parses with the frontmatter name matching the slug/directory", () => {
		const parsed = parseSkillMarkdown(content, {
			directoryName: REVIEW_SKILL_NAME,
			path: `${REVIEW_SKILL_NAME}/SKILL.md`,
		});
		expect(parsed.name).toBe("review-pr");
		expect(parsed.description.length).toBeGreaterThan(0);
		expect(parsed.body.length).toBeGreaterThan(0);
		// allowed-tools is space-delimited; the skill grants the gated tool.
		expect(parsed.allowedTools).toContain("postReview");
	});
});

// ── Live G1–G5 path (requires convex-test or a live `convex` deployment) ────────────────────────────
//
// With convex-test installed (or against `convex run` on a real deployment + the cove-test/mock model):
//
//   1. (G1) registerAgentRegistry(registry); seed the skill:
//          await t.mutation(api.skills.importSkill, { slug: "review-pr", content });
//   2. submit a prompt gated on the HITL tool:
//          const { requestId, instanceId } = await t.mutation(api.invoke.submit.submitPrompt, {
//            agent: "codeReviewer", prompt: "Review PR #42 …",
//            approvalTools: APPROVAL_TOOLS as unknown as string[],
//            model: "cove-test/mock",
//          });
//   3. (G2) poll api.events.read.listForStream({ streamKey: instanceId }) → assert text_delta events.
//   4. (G3/G4) kill + resume the workflow mid-turn → assert a coherent terminal with at-most-once model
//          call per finalized step (the journaled steps replay).
//   5. (G5) when postReview parks an approval, resolve it:
//          await t.mutation(api.engine.approvals.submitApproval, { requestId, toolCallId, approved: true });
//          → assert the run reaches a completed terminal.
//   6. (observability) fold the same events: api.observability.read.exportSpans({ streamKey })
//          → assert a run root span with nested operation/turn/tool spans.
