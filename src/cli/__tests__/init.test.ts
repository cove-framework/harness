// Packaging test — `cove init` scaffolds a vendored backend + starter authoring surface (model C). It copies
// the package's own convex/ + src/runtime/ (dropping tests/_generated/the demo _cove), appends the starter
// registries, regenerates _cove from them, and writes the project files. Verifies the scaffold's shape +
// exclusions + that the regenerated _cove matches the codegen renderer.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAgentResolver } from "../codegen/generate-agent-registry.ts";
import { renderWorkflowResolver } from "../codegen/generate-workflow-registry.ts";
import { initProject } from "../commands/init.ts";

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "cove-init-"));
	// printNextSteps writes to stderr — keep the test output clean.
	vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(dir, { recursive: true, force: true });
});

function read(rel: string): string {
	return fs.readFileSync(path.join(dir, rel), "utf8");
}
function walk(root: string): string[] {
	const out: string[] = [];
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else out.push(path.relative(dir, full));
	}
	return out;
}

describe("cove init", () => {
	it("vendors the backend + writes the starter scaffolding", async () => {
		await initProject({ dir });

		// Vendored backend + V8-safe core.
		for (const f of ["convex/schema.ts", "convex/http.ts", "src/runtime/index.ts"]) {
			expect(fs.existsSync(path.join(dir, f)), `${f} should be vendored`).toBe(true);
		}
		// Project scaffolding.
		for (const f of ["package.json", "cove.config.ts", "tsconfig.json", ".gitignore", ".env.example", "README.md"]) {
			expect(fs.existsSync(path.join(dir, f)), `${f} should be written`).toBe(true);
		}
	});

	it("excludes tests, _generated, and the demo _cove from the copy", async () => {
		await initProject({ dir });
		const files = walk(dir);
		expect(files.filter((f) => f.includes("__tests__"))).toEqual([]);
		expect(files.filter((f) => f.endsWith(".test.ts"))).toEqual([]);
		expect(files.filter((f) => f.includes("_generated"))).toEqual([]);
	});

	it("regenerates _cove resolvers matching the scaffolded registry exports", async () => {
		await initProject({ dir });
		expect(read("convex/_cove/agentResolver.ts")).toBe(renderAgentResolver("registry"));
		expect(read("convex/_cove/workflowResolver.ts")).toBe(renderWorkflowResolver("workflows"));
		// The appended exports the resolvers import against.
		expect(read("convex/agentRegistry.ts")).toContain("export const registry = defineAgentRegistry(");
		expect(read("convex/workflowRegistry.ts")).toContain("export const workflows = defineWorkflowRegistry({})");
	});

	it("writes a project package.json depending on cove + the backend deps", async () => {
		await initProject({ dir });
		const pkg = JSON.parse(read("package.json")) as {
			name: string;
			dependencies: Record<string, string>;
			devDependencies: Record<string, string>;
			scripts: Record<string, string>;
		};
		expect(pkg.name).toBe(path.basename(dir).toLowerCase()); // npm names must be lowercase
		expect(pkg.dependencies.cove).toMatch(/^\^/); // self-dep on the published CLI + client surfaces
		expect(pkg.dependencies.convex).toBeDefined();
		expect(pkg.dependencies.ai).toBeDefined();
		// The vendored runtime imports js-yaml, which has no bundled types.
		expect(pkg.devDependencies["@types/js-yaml"]).toBeDefined();
		expect(pkg.devDependencies.typescript).toBeDefined();
		expect(pkg.scripts.dev).toBe("cove dev");
	});

	it("config dogfoods the published cove/cli export", async () => {
		await initProject({ dir });
		expect(read("cove.config.ts")).toContain('from "cove/cli"');
		expect(read("cove.config.ts")).toContain("defineCoveConfig");
	});

	it("refuses a non-empty target without --force, accepts it with --force", async () => {
		fs.writeFileSync(path.join(dir, "keep.txt"), "x");
		await expect(initProject({ dir })).rejects.toThrow(/not empty/);
		await expect(initProject({ dir, force: true })).resolves.toBeUndefined();
		expect(fs.existsSync(path.join(dir, "convex/schema.ts"))).toBe(true);
	});

	it("does not leak the flue brand into generated files", async () => {
		await initProject({ dir });
		for (const f of ["cove.config.ts", "README.md", "convex/_cove/agentResolver.ts", "package.json"]) {
			expect(read(f)).not.toMatch(/flue|@flue/);
		}
	});
});
