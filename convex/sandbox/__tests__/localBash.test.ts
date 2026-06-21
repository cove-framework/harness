// New (Convex backend) · @cove/runtime · phase-02 acceptance test for localBash()
// Runs the real in-process bash() adapter against a mkdtemp workspace: 9-method
// round-trip + exec("echo hi"), parent-dir auto-create, ../-escape rejection.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SandboxOperationUnsupportedError } from "../../../src/runtime/errors.ts";
import type { SessionEnv } from "../../../src/runtime/types.ts";
import { localBash } from "../localBash.ts";

describe("localBash (real in-process bash)", () => {
	let workspace: string;
	let env: SessionEnv;

	beforeEach(async () => {
		workspace = await mkdtemp(path.join(tmpdir(), "cove-localbash-"));
		env = await localBash({ cwd: workspace }).createSessionEnv({ id: "local-test" });
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	it("runs exec('echo hi')", async () => {
		const result = await env.exec("echo hi");
		expect(result.stdout).toBe("hi\n");
		expect(result.exitCode).toBe(0);
	});

	it("round-trips the 9 SessionEnv methods", async () => {
		// writeFile + readFile
		await env.writeFile("file.txt", "hello world");
		expect(await env.readFile("file.txt")).toBe("hello world");

		// readFileBuffer
		const bytes = await env.readFileBuffer("file.txt");
		expect(new TextDecoder().decode(bytes)).toBe("hello world");

		// stat
		const stat = await env.stat("file.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.size).toBe(11);

		// mkdir + exists + readdir
		await env.mkdir("subdir");
		expect(await env.exists("subdir")).toBe(true);
		expect(await env.exists("nope")).toBe(false);
		const entries = await env.readdir(".");
		expect(entries.sort()).toEqual(["file.txt", "subdir"]);

		// exec
		const echoed = await env.exec("echo hi");
		expect(echoed.stdout).toBe("hi\n");

		// rm
		await env.rm("file.txt");
		expect(await env.exists("file.txt")).toBe(false);
		await env.rm("subdir", { recursive: true });
		expect(await env.exists("subdir")).toBe(false);
	});

	it("auto-creates parent dirs on writeFile('sub/dir/f.txt')", async () => {
		await env.writeFile("sub/dir/f.txt", "deep");
		expect(await env.readFile("sub/dir/f.txt")).toBe("deep");
		expect((await env.stat("sub/dir")).isDirectory).toBe(true);
	});

	it("rejects ../-escape on every method", async () => {
		// createCwdSessionEnv resolves paths in non-async arrows (verbatim flue),
		// so an escape surfaces as a synchronous throw; this helper accepts both a
		// sync throw and an async rejection as "rejected".
		const expectEscape = async (op: () => unknown) => {
			let caught: unknown;
			try {
				await op();
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(SandboxOperationUnsupportedError);
		};

		await expectEscape(() => env.readFile("../secret"));
		await expectEscape(() => env.writeFile("../../evil", "x"));
		await expectEscape(() => env.stat("a/../../b"));
		await expectEscape(() => env.exec("echo hi", { cwd: "../.." }));
		await expectEscape(() => env.readFile("/etc/passwd"));
	});
});
