// Tests for the built-in framework tools (engine/frameworkTools.ts) against an in-memory fake env.
import { describe, expect, it } from "vitest";
import type { FileStat, SessionEnv, ShellResult } from "../../../src/runtime/types.ts";
import { createFrameworkTool, createFrameworkTools, formatBashResult } from "../frameworkTools.ts";
import type { EngineToolResult } from "../types.ts";

function makeFakeEnv(opts?: {
	exec?: (cmd: string) => ShellResult;
	files?: Record<string, string>;
	dirs?: string[];
}): SessionEnv {
	const files = new Map<string, string>(Object.entries(opts?.files ?? {}));
	const dirs = new Set<string>(opts?.dirs ?? []);
	const readFile = async (p: string): Promise<string> => {
		const f = files.get(p);
		if (f === undefined) throw new Error(`ENOENT: ${p}`);
		return f;
	};
	const stat = async (p: string): Promise<FileStat> => {
		if (dirs.has(p)) return { isFile: false, isDirectory: true };
		if (files.has(p)) return { isFile: true, isDirectory: false };
		throw new Error(`ENOENT: ${p}`);
	};
	return {
		cwd: "/work",
		resolvePath: (p) => p,
		exec: async (cmd) => (opts?.exec ? opts.exec(cmd) : { stdout: "", stderr: "", exitCode: 0 }),
		readFile,
		readFileBuffer: async (p) => new TextEncoder().encode(await readFile(p)),
		writeFile: async (p, c) => void files.set(p, typeof c === "string" ? c : new TextDecoder().decode(c)),
		stat,
		readdir: async (p) => [...files.keys()].filter((k) => k.startsWith(`${p}/`)),
		exists: async (p) => files.has(p) || dirs.has(p),
		mkdir: async () => {},
		rm: async (p) => void files.delete(p),
	};
}

const firstText = (r: EngineToolResult): string => {
	const block = r.content[0];
	return block && block.type === "text" ? block.text : "";
};

describe("read tool", () => {
	it("reads a file and reports line count", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "line1\nline2" } });
		const read = createFrameworkTool("read", env)!;
		const r = await read.execute({ path: "/work/a.txt" });
		expect(firstText(r)).toBe("line1\nline2");
		expect((r.details as { lines: number }).lines).toBe(2);
	});
	it("lists a directory", async () => {
		const env = makeFakeEnv({ files: { "/work/dir/x": "1", "/work/dir/y": "2" }, dirs: ["/work/dir"] });
		const read = createFrameworkTool("read", env)!;
		const r = await read.execute({ path: "/work/dir" });
		expect((r.details as { isDirectory: boolean }).isDirectory).toBe(true);
	});
	it("applies offset/limit", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "1\n2\n3\n4\n5" } });
		const read = createFrameworkTool("read", env)!;
		const r = await read.execute({ path: "/work/a.txt", offset: 2, limit: 2 });
		expect(firstText(r)).toBe("2\n3");
	});
});

describe("write tool", () => {
	it("writes and reports bytes", async () => {
		const env = makeFakeEnv();
		const write = createFrameworkTool("write", env)!;
		const r = await write.execute({ path: "/work/new.txt", content: "hello" });
		expect(firstText(r)).toContain("Successfully wrote 5 bytes");
		expect(await env.readFile("/work/new.txt")).toBe("hello");
	});
});

describe("edit tool", () => {
	it("replaces a unique occurrence", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "foo bar baz" } });
		const edit = createFrameworkTool("edit", env)!;
		await edit.execute({ path: "/work/a.txt", oldText: "bar", newText: "QUX" });
		expect(await env.readFile("/work/a.txt")).toBe("foo QUX baz");
	});
	it("replaceAll replaces every occurrence", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "x x x" } });
		const edit = createFrameworkTool("edit", env)!;
		const r = await edit.execute({ path: "/work/a.txt", oldText: "x", newText: "y", replaceAll: true });
		expect(await env.readFile("/work/a.txt")).toBe("y y y");
		expect((r.details as { replacements: number }).replacements).toBe(3);
	});
	it("rejects a non-unique match without replaceAll", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "x x" } });
		const edit = createFrameworkTool("edit", env)!;
		await expect(edit.execute({ path: "/work/a.txt", oldText: "x", newText: "y" })).rejects.toThrow(
			/Found 2 occurrences/,
		);
	});
	it("rejects when oldText is absent", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "abc" } });
		const edit = createFrameworkTool("edit", env)!;
		await expect(edit.execute({ path: "/work/a.txt", oldText: "zzz", newText: "y" })).rejects.toThrow(
			/Could not find/,
		);
	});
});

describe("bash tool", () => {
	it("returns stdout for a successful command", async () => {
		const env = makeFakeEnv({ exec: () => ({ stdout: "hello", stderr: "", exitCode: 0 }) });
		const bash = createFrameworkTool("bash", env)!;
		const r = await bash.execute({ command: "echo hello" });
		expect(firstText(r)).toBe("hello");
		expect((r.details as { exitCode: number }).exitCode).toBe(0);
	});
	it("appends the exit line on a non-zero exit", () => {
		const r = formatBashResult({ stdout: "boom", stderr: "", exitCode: 2 }, "false");
		expect(firstText(r)).toContain("Command exited with code 2");
	});
});

describe("grep tool", () => {
	it("returns matches via the grep backend", async () => {
		const env = makeFakeEnv({
			exec: (cmd) => {
				if (cmd === "rg --version") return { stdout: "", stderr: "no rg", exitCode: 127 };
				return { stdout: "/work/a.ts:1:hit", stderr: "", exitCode: 0 };
			},
		});
		const grep = createFrameworkTool("grep", env)!;
		const r = await grep.execute({ pattern: "hit" });
		expect(firstText(r)).toContain("/work/a.ts:1:hit");
		expect((r.details as { matchCount: number }).matchCount).toBe(1);
	});
	it("reports no matches on exit code 1", async () => {
		const env = makeFakeEnv({
			exec: (cmd) =>
				cmd === "rg --version"
					? { stdout: "", stderr: "", exitCode: 127 }
					: { stdout: "", stderr: "", exitCode: 1 },
		});
		const grep = createFrameworkTool("grep", env)!;
		const r = await grep.execute({ pattern: "nope" });
		expect(firstText(r)).toBe("No matches found.");
	});
});

describe("glob tool", () => {
	it("returns matching paths", async () => {
		const env = makeFakeEnv({ exec: () => ({ stdout: "/work/a.ts\n/work/b.ts", stderr: "", exitCode: 0 }) });
		const glob = createFrameworkTool("glob", env)!;
		const r = await glob.execute({ pattern: "*.ts" });
		expect((r.details as { matchCount: number }).matchCount).toBe(2);
	});
	it("reports none found", async () => {
		const env = makeFakeEnv({ exec: () => ({ stdout: "", stderr: "", exitCode: 1 }) });
		const glob = createFrameworkTool("glob", env)!;
		const r = await glob.execute({ pattern: "*.zz" });
		expect(firstText(r)).toBe("No files found matching pattern.");
	});
});

describe("createFrameworkTools", () => {
	it("exposes the six env-bound built-ins", () => {
		const names = createFrameworkTools(makeFakeEnv()).map((t) => t.name).sort();
		expect(names).toEqual(["bash", "edit", "glob", "grep", "read", "write"]);
	});
	it("aborts a pre-aborted call", async () => {
		const env = makeFakeEnv({ files: { "/work/a.txt": "x" } });
		const read = createFrameworkTool("read", env)!;
		await expect(read.execute({ path: "/work/a.txt" }, AbortSignal.abort())).rejects.toThrow();
	});
});
