// G2.4 CLI test — m3 packaging: a clean skill dir packages to cove.skills.json; a dir with .ssh /
// credentials.json / *.pem THROWS (the sensitive-file security boundary, doc 08 §Risks). No `with { type:'skill' }`
// or brand leakage in the emitted catalog.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packageSkills } from "../packaging/package-skills.ts";

let root: string;
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "cove-skills-"));
});
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function makeSkill(name: string, extra?: (skillDir: string) => void): string {
	const skillsDir = path.join(root, "skills");
	const skillDir = path.join(skillsDir, name);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: A clean test skill for packaging.\n---\n\n# ${name}\n\nDo the thing.\n`,
		"utf-8",
	);
	extra?.(skillDir);
	return skillsDir;
}

describe("package-skills (m3)", () => {
	it("packages a clean skill dir into cove.skills.json", async () => {
		const skillsDir = makeSkill("review-pr", (d) => {
			fs.writeFileSync(path.join(d, "reference.md"), "extra reference\n", "utf-8");
		});
		const result = await packageSkills({ root, skillSources: [skillsDir] });
		expect(result.changed).toBe(true);
		expect(result.count).toBe(1);

		const catalog = JSON.parse(fs.readFileSync(result.path, "utf-8"));
		expect(catalog.skills).toHaveLength(1);
		const entry = catalog.skills[0];
		expect(entry.reference.__coveSkillReference).toBe(true);
		expect(entry.reference.name).toBe("review-pr");
		expect(entry.directory.id).toMatch(/^skill:review-pr:[0-9a-f]{16}$/);
		expect(Object.keys(entry.directory.files)).toContain("SKILL.md");
		expect(Object.keys(entry.directory.files)).toContain("reference.md");

		// No brand leakage / no import-attribute machinery in the emitted catalog.
		const raw = fs.readFileSync(result.path, "utf-8");
		expect(raw).not.toMatch(/__flueSkillReference|type:\s*['"]skill['"]/);
	});

	it("is idempotent (no-op on a second run with identical input)", async () => {
		const skillsDir = makeSkill("review-pr");
		const first = await packageSkills({ root, skillSources: [skillsDir] });
		expect(first.changed).toBe(true);
		const second = await packageSkills({ root, skillSources: [skillsDir] });
		expect(second.changed).toBe(false);
	});

	it("THROWS on a .ssh directory", async () => {
		const skillsDir = makeSkill("review-pr", (d) => {
			fs.mkdirSync(path.join(d, ".ssh"));
			fs.writeFileSync(path.join(d, ".ssh", "id_rsa"), "PRIVATE", "utf-8");
		});
		await expect(packageSkills({ root, skillSources: [skillsDir] })).rejects.toThrow(
			/sensitive directory/,
		);
	});

	it("THROWS on credentials.json", async () => {
		const skillsDir = makeSkill("review-pr", (d) => {
			fs.writeFileSync(path.join(d, "credentials.json"), "{}", "utf-8");
		});
		await expect(packageSkills({ root, skillSources: [skillsDir] })).rejects.toThrow(
			/sensitive file/,
		);
	});

	it("THROWS on a *.pem file", async () => {
		const skillsDir = makeSkill("review-pr", (d) => {
			fs.writeFileSync(path.join(d, "server.pem"), "-----BEGIN-----", "utf-8");
		});
		await expect(packageSkills({ root, skillSources: [skillsDir] })).rejects.toThrow(
			/sensitive file/,
		);
	});
});
