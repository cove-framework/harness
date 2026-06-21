// Tests for the entry diff-sync helper (sessions/diff.ts).
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../../../src/runtime/types.ts";
import { computeEntryInserts } from "../diff.ts";

function entry(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "t",
		message: { role: "user", content: "x", timestamp: 0 },
	} as SessionEntry;
}

describe("computeEntryInserts", () => {
	it("returns only new entries with sequential positions from nextPosition", () => {
		const entries = [entry("a", null), entry("b", "a"), entry("c", "b")];
		const inserts = computeEntryInserts(new Set(["a"]), entries, 1);
		expect(inserts).toEqual([
			{ entry: entries[1], position: 1 },
			{ entry: entries[2], position: 2 },
		]);
	});

	it("is empty when all entries are already persisted (O(new) writes)", () => {
		const entries = [entry("a", null), entry("b", "a")];
		expect(computeEntryInserts(new Set(["a", "b"]), entries, 2)).toEqual([]);
	});

	it("appends a whole fresh history from position 0", () => {
		const entries = [entry("a", null), entry("b", "a")];
		const inserts = computeEntryInserts(new Set(), entries, 0);
		expect(inserts.map((i) => i.position)).toEqual([0, 1]);
	});
});
