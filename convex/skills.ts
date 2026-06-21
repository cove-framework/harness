// New (Convex backend) · @cove/runtime — skills CATALOG (doc 06 P10, D13). flue discovered skills from the
// filesystem (context.ts AGENTS.md/.agents walk); cove replaces that with a catalog TABLE: importSkill parses
// a host-supplied SKILL.md via parseSkillMarkdown and writes idempotent rows (no box, no sandbox FS read —
// the import source is the host/repo). Skills are RESOLVED only from the catalog at runtime (activate_skill /
// session.skill); on-demand SessionEnv reads are for non-skill workspace context only (doc 08 §3). No "use node".

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { parseSkillMarkdown } from "../src/runtime/skill-frontmatter.ts";

/** Deterministic content hash for idempotent re-import (FNV-1a hex + length). */
function contentHash(s: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
	return `sk_${(h >>> 0).toString(16)}_${s.length.toString(16)}`;
}

/** Import (or re-import) a skill from its SKILL.md text. Idempotent on content (slug = frontmatter name). */
export const importSkill = mutation({
	args: { slug: v.string(), content: v.string() },
	handler: async (ctx, { slug, content }): Promise<{ slug: string; changed: boolean }> => {
		const parsed = parseSkillMarkdown(content, { directoryName: slug, path: `${slug}/SKILL.md` });
		const hash = contentHash(content);
		const existing = await ctx.db
			.query("skills")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		const now = Date.now();
		const row = {
			slug,
			name: parsed.name,
			description: parsed.description,
			isActive: true,
			instructions: parsed.body,
			references: [],
			requiredTools: parsed.allowedTools,
			contentHash: hash,
			updatedAt: now,
		};
		if (existing) {
			if (existing.contentHash === hash && existing.isActive) return { slug, changed: false };
			await ctx.db.patch(existing._id, row);
			return { slug, changed: true };
		}
		await ctx.db.insert("skills", row);
		return { slug, changed: true };
	},
});

/** Soft-delete a skill (isActive=false) — keeps history, hides it from resolution. */
export const deactivateSkill = mutation({
	args: { slug: v.string() },
	handler: async (ctx, { slug }) => {
		const existing = await ctx.db
			.query("skills")
			.withIndex("by_slug", (q) => q.eq("slug", slug))
			.unique();
		if (existing) await ctx.db.patch(existing._id, { isActive: false, updatedAt: Date.now() });
	},
});

/** The active skills registry (name + description) — rendered into the system prompt + the activate_skill enum. */
export const listSkills = query({
	args: {},
	handler: async (ctx) => {
		const rows = await ctx.db
			.query("skills")
			.withIndex("by_isActive", (q) => q.eq("isActive", true))
			.collect();
		return rows.map((r) => ({ slug: r.slug, name: r.name, description: r.description }));
	},
});

/** Resolve one skill's full instructions by name (= slug) — the activate_skill / session.skill read path. */
export const getSkill = query({
	args: { name: v.string() },
	handler: async (ctx, { name }) => {
		const r = await ctx.db
			.query("skills")
			.withIndex("by_slug", (q) => q.eq("slug", name))
			.unique();
		if (!r || !r.isActive) return null;
		return {
			slug: r.slug,
			name: r.name,
			description: r.description,
			instructions: r.instructions,
			requiredTools: r.requiredTools,
		};
	},
});
