// Ported from flue · @flue/runtime · test-utils/define-store-contract-tests.ts (the `sessions` describe, the
// SessionStore half) → @cove/runtime. Reshaped to the Convex backend: the in-process `Store` becomes the
// real sessions/store + persist helpers driven under convex-test (edge-runtime VM). flue's SessionData blob
// maps to the decomposed sessions + sessionEntries + imageChunks rows.
//
// M6 / D5: the AgentSubmissionStore half (dispatch/claim/lease/turn-journal/stream-chunks/attempt-markers)
// is NOT ported — durable recovery is owned by @convex-dev/workflow; those assertions die with the dropped
// machinery (08 §5). The surviving admission invariants were asserted in P6. Exactly three store harnesses.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import schema from "../../convex/schema.ts";
import { getOrCreateSessionId } from "../../convex/invoke/admit.ts";
import {
	appendCanonicalEntry,
	cascadeDeleteSession,
	loadSessionData,
} from "../../convex/sessions/persist.ts";
import type { AgentMessage } from "../../src/runtime/messages.ts";

const modules = import.meta.glob("../../convex/**/*.ts");
const REF = { instanceId: "i1", harnessName: "default", sessionName: "default" };
const userMsg = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1000 });

describe("Convex SessionStore contract (G2.6, sessions half)", () => {
	it("loads null for a missing session", async () => {
		const t = convexTest(schema, modules);
		const data = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, REF);
			await cascadeDeleteSession(ctx, id); // create then delete → the id is now absent
			return loadSessionData(ctx, id);
		});
		expect(data).toBeNull();
	});

	it("round-trips a SessionData (save → load)", async () => {
		const t = convexTest(schema, modules);
		const data = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, REF);
			await appendCanonicalEntry(ctx, id, "e1", userMsg("first"), 1000);
			await appendCanonicalEntry(ctx, id, "e2", userMsg("second"), 1001);
			return loadSessionData(ctx, id);
		});
		expect(data?.version).toBe(6);
		expect(data?.entries.map((e) => (e as { message: AgentMessage }).message)).toEqual([
			userMsg("first"),
			userMsg("second"),
		]);
		expect(data?.leafId).toBe("e2");
	});

	it("round-trips a large image through content-addressed imageChunks (hoist → hydrate, dedup)", async () => {
		const t = convexTest(schema, modules);
		const IMG = "A".repeat(300_000); // ~300 KB base64 (inline; >1 MiB _storage spill is a documented follow-up)
		const imageMsg: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text: "look" },
				{ type: "image", data: IMG, mimeType: "image/png" },
			],
			timestamp: 1000,
		};
		const { data, chunkCount } = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, REF);
			await appendCanonicalEntry(ctx, id, "img1", imageMsg, 1000);
			await appendCanonicalEntry(ctx, id, "img2", imageMsg, 1001); // same bytes → dedup (refCount 2)
			const loaded = await loadSessionData(ctx, id);
			const chunks = await ctx.db.query("imageChunks").collect();
			return { data: loaded, chunkCount: chunks.length };
		});
		// Both entries hydrate the full bytes; the bytes are stored once (content-addressed dedup).
		const blocks = data?.entries.flatMap((e) =>
			Array.isArray((e as { message: { content: unknown } }).message.content)
				? ((e as { message: { content: { type: string; data?: string }[] } }).message.content)
				: [],
		);
		const images = blocks?.filter((b) => b.type === "image") ?? [];
		expect(images).toHaveLength(2);
		expect(images.every((b) => b.data === IMG)).toBe(true);
		expect(chunkCount).toBe(1);
	});

	it("is idempotent on overwrite (same entryId appended twice → one entry)", async () => {
		const t = convexTest(schema, modules);
		const count = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, REF);
			await appendCanonicalEntry(ctx, id, "dup", userMsg("once"), 1000);
			await appendCanonicalEntry(ctx, id, "dup", userMsg("twice"), 1001); // same entryId → no-op
			const loaded = await loadSessionData(ctx, id);
			return loaded?.entries.length ?? 0;
		});
		expect(count).toBe(1);
	});

	it("deletes a session and tolerates delete-missing as a no-op", async () => {
		const t = convexTest(schema, modules);
		const after = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, REF);
			await appendCanonicalEntry(ctx, id, "e1", userMsg("x"), 1000);
			await cascadeDeleteSession(ctx, id);
			await cascadeDeleteSession(ctx, id); // delete-missing → no throw
			return loadSessionData(ctx, id);
		});
		expect(after).toBeNull();
	});
});
