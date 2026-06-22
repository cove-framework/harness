// New (Convex backend) · @cove/runtime — G2.6 throughput gate (08 §4.6). Full-stack: the pure DeltaBatcher
// (production cadence 480 chars / 400 ms) wired to the REAL steps.patchStreaming mutation under convex-test.
// Asserts N≥200 streamed deltas coalesce into FAR fewer in-position step-row patches, the row text is
// lossless, and the patch is committed (readable) before the workflow would advance.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema.ts";
import { DeltaBatcher, type DeltaPatch } from "../../convex/engine/deltaBatcher.ts";
import { getOrCreateSessionId } from "../../convex/invoke/admit.ts";

const modules = import.meta.glob("../../convex/**/*.ts");

describe("delta-batcher throughput (G2.6, full-stack)", () => {
	it("coalesces 200 token deltas into far fewer in-position patches, lossless", async () => {
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
				submissionId: "sub-perf",
				kind: "prompt",
				input: "hi",
				status: "running",
				createdAt: now,
				updatedAt: now,
			});
		});
		await t.mutation(internal.engine.steps.insertStreaming, { requestId, stepNumber: 0 });

		// Production cadence; a constant clock so only the char threshold (480) flushes — deterministic.
		let flushes = 0;
		const sink = async (patch: DeltaPatch): Promise<void> => {
			flushes++;
			await t.mutation(internal.engine.steps.patchStreaming, {
				requestId,
				stepNumber: 0,
				text: patch.text,
				reasoning: patch.reasoning,
			});
		};
		const batcher = new DeltaBatcher(sink, { maxChars: 480, maxMs: 400, now: () => 0 });

		const N = 200;
		const DELTA = "0123456789012345678"; // 19 chars/delta → 3800 chars total
		for (let i = 0; i < N; i++) await batcher.text(DELTA);
		await batcher.flush();

		const row = await t.query(internal.engine.steps.byRequestStep, { requestId, stepNumber: 0 });
		expect(row?.text).toBe(DELTA.repeat(N)); // lossless — no delta dropped
		expect(row?.text.length).toBe(N * DELTA.length);
		// Coalesced: ~3800/480 ≈ 8 flushes, vastly fewer than 200 per-token mutations.
		expect(flushes).toBeLessThan(N / 5);
		expect(flushes).toBeGreaterThan(0);
	});
});
