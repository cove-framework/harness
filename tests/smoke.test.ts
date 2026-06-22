// New (Convex backend) · @cove/runtime — G2.6 convex-test smoke: confirm convexTest(schema) runs Convex
// functions in the edge-runtime VM (the gating validation for the whole hermetic suite).
import { convexTest } from "convex-test";
import { describe, expect, it } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema.ts";

// convex-test needs the function modules; tests/ is outside convex/, so pass an explicit glob.
const modules = import.meta.glob("../convex/**/*.ts");

describe("convex-test smoke (edge-runtime VM)", () => {
	it("runs a direct ctx.db round-trip", async () => {
		const t = convexTest(schema, modules);
		const count = await t.run(async (ctx) => {
			await ctx.db.insert("meta", { key: "smoke", value: { ok: true } });
			const rows = await ctx.db
				.query("meta")
				.withIndex("by_key", (q) => q.eq("key", "smoke"))
				.collect();
			return rows.length;
		});
		expect(count).toBe(1);
	});

	it("invokes a real query (skills.listSkills) against the in-memory deployment", async () => {
		const t = convexTest(schema, modules);
		const skills = await t.query(api.skills.listSkills, {});
		expect(Array.isArray(skills)).toBe(true);
		expect(skills.length).toBe(0); // empty catalog in a fresh deployment
	});
});
