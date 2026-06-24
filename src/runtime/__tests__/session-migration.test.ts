// Tests for the forward-only SessionData migration seam (src/runtime/session-history.ts).
import { describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, migrateSessionData, SessionHistory } from "../session-history.ts";
import type { SessionData } from "../types.ts";

function v6(overrides: Partial<SessionData> = {}): SessionData {
	return {
		version: 6,
		affinityKey: "aff_01ARZ3NDEKTSV4RRFFQ69G5FAV",
		entries: [],
		leafId: null,
		taskSessions: [],
		metadata: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("migrateSessionData", () => {
	it("passes current-version data through unchanged", () => {
		const data = v6();
		expect(migrateSessionData(data).version).toBe(CURRENT_SESSION_VERSION);
		expect(migrateSessionData(data)).toEqual(data);
	});

	it("throws on data newer than this build supports", () => {
		expect(() => migrateSessionData(v6({ version: CURRENT_SESSION_VERSION + 1 }))).toThrow(
			/newer than this Cove build supports/,
		);
	});

	it("throws a clear no-path error for an old version with no registered migration", () => {
		expect(() => migrateSessionData(v6({ version: 5 }))).toThrow(/No migration path/);
	});
});

describe("SessionHistory.fromData", () => {
	it("routes through migration and builds an empty context for fresh data", () => {
		const history = SessionHistory.fromData(v6());
		expect(history.getLeafId()).toBeNull();
		expect(history.buildContext()).toEqual([]);
	});

	it("returns an empty history for null data", () => {
		expect(SessionHistory.fromData(null).buildContext()).toEqual([]);
	});

	it("still rejects a malformed affinity key after migration", () => {
		expect(() => SessionHistory.fromData(v6({ affinityKey: "nope" }))).toThrow(
			/affinity key is malformed/,
		);
	});

	it("excludes extension `custom` entries from the LLM context (Phase 5b appendEntry)", () => {
		const data = v6({
			entries: [
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-01-01T00:00:00.000Z",
					message: { role: "user", content: "hi", timestamp: 0 },
				},
				{
					type: "custom",
					id: "c1",
					parentId: "m1",
					timestamp: "2026-01-01T00:00:01.000Z",
					customType: "audit-log",
					data: { note: "extension state" },
				},
			] as never,
			leafId: "c1",
		});
		const history = SessionHistory.fromData(data);
		const context = history.buildContext();
		expect(context).toHaveLength(1); // the custom entry is on the active path but NOT in context
		expect(context[0]?.role).toBe("user");
	});
});
