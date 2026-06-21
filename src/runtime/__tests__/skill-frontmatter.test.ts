// Tests for the ported skill frontmatter parser (src/runtime/skill-frontmatter.ts).
import { describe, expect, it } from "vitest";
import { parseSkillMarkdown } from "../skill-frontmatter.ts";

const opts = (directoryName: string) => ({ directoryName, path: `${directoryName}/SKILL.md` });

describe("parseSkillMarkdown", () => {
	it("parses frontmatter + body", () => {
		const md = `---\nname: review-pr\ndescription: Review a pull request.\nallowed-tools: read grep\n---\nDo the review carefully.\n`;
		const parsed = parseSkillMarkdown(md, opts("review-pr"));
		expect(parsed.name).toBe("review-pr");
		expect(parsed.description).toBe("Review a pull request.");
		expect(parsed.body).toBe("Do the review carefully.");
		expect(parsed.allowedTools).toEqual(["read", "grep"]);
	});

	it("rejects missing frontmatter", () => {
		expect(() => parseSkillMarkdown("no frontmatter here", opts("x"))).toThrow(/missing YAML frontmatter/);
	});

	it("requires name to match the directory", () => {
		const md = `---\nname: other\ndescription: d\n---\nbody`;
		expect(() => parseSkillMarkdown(md, opts("review-pr"))).toThrow(/match directory/);
	});

	it("rejects non-spec names", () => {
		const md = `---\nname: Bad_Name\ndescription: d\n---\nbody`;
		expect(() => parseSkillMarkdown(md, opts("Bad_Name"))).toThrow(/lowercase letters, numbers, and hyphens/);
	});

	it("rejects an over-long description", () => {
		const md = `---\nname: x\ndescription: ${"d".repeat(1025)}\n---\nbody`;
		expect(() => parseSkillMarkdown(md, opts("x"))).toThrow(/1024-character/);
	});
});
