// Ported from flue · @flue/runtime · test-utils/define-run-store-contract-tests.ts → @cove/runtime.
// Reshaped to the Convex RunStore (convex/runs.ts). NOTE: the runs-row WRITER is G2.4/D18 — nothing writes
// the `runs` table yet, so runs.get serves the agentRequests-backed point-in-time fallback and listRuns
// returns []. The create→get/endRun/cursor-paging assertions that need a written row are it.skip'd with a
// pointer to G2.4; the read-side fallback IS asserted here (it fails loudly, not silently, if absent).
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import schema from "../../convex/schema.ts";
import { getOrCreateSessionId } from "../../convex/invoke/admit.ts";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("Convex RunStore contract (G2.6)", () => {
	it("listRuns returns [] until the runs-row writer lands (G2.4/D18)", async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(api.runs.listRuns, {})).toEqual([]);
		expect(await t.query(api.runs.listRuns, { agentName: "anything" })).toEqual([]);
	});

	it("get returns null for an unknown/invalid runId", async () => {
		const t = convexTest(schema, modules);
		expect(await t.query(api.runs.get, { runId: "not-a-real-id" })).toBeNull();
	});

	it("get falls back to the agentRequests point-in-time view (parity with requests.get + GET /runs/:runId)", async () => {
		const t = convexTest(schema, modules);
		const requestId = await t.run(async (ctx) => {
			const sessionId = await getOrCreateSessionId(ctx, {
				instanceId: "i1",
				harnessName: "default",
				sessionName: "default",
			});
			const now = Date.now();
			return ctx.db.insert("agentRequests", {
				sessionId,
				instanceId: "i1",
				submissionId: "sub-1",
				kind: "prompt",
				input: "hi",
				status: "completed",
				finalText: "done",
				createdAt: now,
				updatedAt: now,
			});
		});
		const rec = await t.query(api.runs.get, { runId: requestId });
		expect(rec).not.toBeNull();
		expect(rec?.runId).toBe(requestId);
		expect(rec?.instanceId).toBe("i1");
		expect(rec?.status).toBe("completed");
	});

	it.skip("create → get → endRun (needs the runs-row writer — G2.4/D18)", () => {
		// The flue createRun/endRun/idempotent-replay/cursor-paging assertions require a runs-row writer,
		// which lands in G2.4 (the kind:'workflow' run lifecycle). Re-enable when the writer exists.
	});
});
