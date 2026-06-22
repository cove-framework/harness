// New (Convex backend) · @cove/runtime — G2.6 compaction invariants (04 / 08 §4.1). The threshold FIRING
// (decode → loop → journaled compact step) and the summarization (generateText) are "use node" / pure-tested
// (G2.5 wiring + src/runtime/compaction unit). Here we prove the STORE invariant under convex-test: an
// appended CompactionEntry makes the next decode's rebuilt context `[summary + retained tail]` (older entries
// folded away), plus the threshold predicate the wiring gates on.
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema.ts";
import { getOrCreateSessionId } from "../../convex/invoke/admit.ts";
import { appendCanonicalEntry, loadSessionData } from "../../convex/sessions/persist.ts";
import { shouldCompact } from "../../src/runtime/compaction.ts";
import { SessionHistory } from "../../src/runtime/session-history.ts";
import type { AgentMessage } from "../../src/runtime/messages.ts";

const modules = import.meta.glob("../../convex/**/*.ts");
const user = (text: string): AgentMessage => ({ role: "user", content: text, timestamp: 1000 });

describe("compaction store invariant (G2.6)", () => {
	it("appends a CompactionEntry; the next decode context is [summary + retained tail]", async () => {
		const t = convexTest(schema, modules);
		const sessionId = await t.run(async (ctx) => {
			const id = await getOrCreateSessionId(ctx, {
				instanceId: "i1",
				harnessName: "default",
				sessionName: "default",
			});
			await appendCanonicalEntry(ctx, id, "e1", user("FIRST older message"), 1000);
			await appendCanonicalEntry(ctx, id, "e2", user("SECOND older message"), 1001);
			await appendCanonicalEntry(ctx, id, "e3", user("THIRD recent message"), 1002);
			return id;
		});

		await t.mutation(internal.sessions.store.appendCompactionEntry, {
			sessionId,
			summary: "COMPACTION-SUMMARY of the earlier work",
			firstKeptEntryId: "e3", // keep e3 verbatim; fold e1+e2 into the summary
			tokensBefore: 1234,
		});

		const context = await t.run(async (ctx) => {
			const data = await loadSessionData(ctx, sessionId);
			return SessionHistory.fromData(data).buildContext();
		});
		const text = JSON.stringify(context);
		expect(text).toContain("COMPACTION-SUMMARY"); // the summary is present
		expect(text).toContain("THIRD recent message"); // the retained tail is present verbatim
		expect(text).not.toContain("FIRST older message"); // folded away
		expect(text).not.toContain("SECOND older message");
	});

	it("the threshold predicate fires past contextWindow − reserveTokens (the wiring gate)", () => {
		const settings = { enabled: true, reserveTokens: 20_000, keepRecentTokens: 8_000 };
		expect(shouldCompact(190_000, 200_000, settings)).toBe(true); // 190k > 180k
		expect(shouldCompact(150_000, 200_000, settings)).toBe(false); // under threshold
		expect(shouldCompact(190_000, 200_000, { ...settings, enabled: false })).toBe(false); // disabled
		expect(shouldCompact(999_999, 0, settings)).toBe(false); // unknown window → threshold off
	});
});
