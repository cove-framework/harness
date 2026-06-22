# codeReviewer — a worked Cove sample agent

A small-but-real agent that reviews a pull request and posts a verdict through a **human-gated** tool. It
exercises every success criterion (G1–G5) of the Cove runtime.

| file | purpose |
| --- | --- |
| `agent.ts` | `createAgent` (G1) + the HITL-gated `postReview` `defineTool` (G5) + the `review-pr` catalog skill ref. Exports `APPROVAL_TOOLS` and `REVIEW_SKILL_NAME`. |
| `registry.ts` | `defineAgentRegistry({ codeReviewer })` — the addressable registration the codegen installs. |
| `review-pr.skill.md` | the `SKILL.md` (frontmatter `name: review-pr`) seeded into the skills catalog via `importSkill`. |
| `__tests__/codeReviewer.e2e.test.ts` | the deterministic, pure portions of the E2E (compiles + validates without `convex-test`). |

## Run it

> The deterministic test (below) needs nothing external. A **live** end-to-end run needs a deployable
> Convex deployment, a provider key (or the reserved `cove-test/mock` model), and — for the registered-agent
> path — the `cove` CLI codegen (G2.4) that installs `registerAgentRegistry(registry)`.

1. **Start the dev backend** (codegen installs the registry from `registry.ts`):

   ```sh
   cove dev
   ```

2. **Seed the skill into the catalog** (catalog-only resolution — no sandbox FS read, doc 08 §3):

   ```sh
   # importSkill(slug, content): the slug must equal the frontmatter name "review-pr"
   convex run skills:importSkill '{"slug":"review-pr","content":"<contents of review-pr.skill.md>"}'
   ```

3. **Send a prompt, gating the HITL tool.** The HITL gate is a *submission-time* concern (it lives on the
   request, not on the agent config), so pass `approvalTools: ["postReview"]`:

   ```sh
   convex run invoke/submit:submitPrompt '{
     "agent": "codeReviewer",
     "prompt": "Review PR #42: it adds an unvalidated path join in fileServer.ts.",
     "approvalTools": ["postReview"]
   }'
   ```

   (For a free, deterministic local run, omit `agent`/key and pass `"model":"cove-test/mock"`.)

4. **Watch the stream** reactively (G2): subscribe to `events:listForStream` with the run's `streamKey`
   to see `text_delta` events arrive live.

5. **Approve the gated tool** (G5): when `postReview` parks an approval, resolve it:

   ```sh
   convex run engine/approvals:submitApproval '{
     "requestId": "<id>", "toolCallId": "<id>", "approved": true
   }'
   ```

6. **Export OTel spans** from the same events (observability): fold the stream into a span tree:

   ```sh
   convex run observability/read:exportSpans '{"streamKey":"<runId-or-instanceId>"}'
   ```

## G1–G5 mapping

| goal | where | observable behavior |
| --- | --- | --- |
| **G1** interface fidelity | `agent.ts` (`createAgent`, `defineTool`), `registry.ts` (`defineAgentRegistry`) | the agent + registry + tool compile and register; `registry.get("codeReviewer")` resolves. |
| **G2** realtime | `convex/events/read.ts` `listForStream` | `text_delta` events stream live to a reactive subscriber as the model writes the review. |
| **G3** durable | `convex/engine/loop.ts` + `runHandler.ts` (journaled `step.run*`) | a redeploy/crash mid-turn replays from the journal to a coherent terminal — at-most-once model call per finalized step. |
| **G4** sandbox parity | `session.env` (when a sandbox is configured) | the review reasons over the diff; if the agent shells, the same code runs across isolate/local/remote sandboxes. (This sample reviews in-context — no shell required.) |
| **G5** additive HITL | `APPROVAL_TOOLS = ["postReview"]` passed at submit → `convex/engine/approvals.ts` | `postReview` parks an approval card; the run stays parked until `submitApproval` resolves it, then completes. |

## Notes

- `approvalTools` is **not** an `AgentRuntimeConfig` field (`createAgent` rejects unknown config fields,
  see `src/runtime/agent-definition.ts`). The HITL gate is set on the **submission** (the request/plan
  `approvalTools` array). `agent.ts` exports `APPROVAL_TOOLS` as the canonical list to pass through.
- The `review-pr` skill is resolved from the **catalog** (`skills:getSkill`), never the sandbox
  filesystem — `session.skill("review-pr")` and `activate_skill` both read the seeded row.
