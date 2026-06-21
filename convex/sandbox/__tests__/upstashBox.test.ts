// New (Convex backend) · @cove/runtime · phase-02 acceptance test for upstashBox()
// Drives the SandboxApi/SessionEnv round-trip against an in-memory FakeBoxClient
// (a tiny shell interpreter for the stat/test/mkdir/rm shell-outs + the base64
// `timeout … bash -l` exec wrap). No live Upstash, no network.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { OperationFailedError, SandboxOperationUnsupportedError } from "../../../src/runtime/errors.ts";
import {
	upstashBox,
	type UpstashBoxClient,
	type UpstashBoxData,
	type UpstashBoxInstance,
} from "../upstashBox.ts";

// ─── In-memory box ────────────────────────────────────────────────────────────

interface FsNode {
	dir: boolean;
	content?: string; // for files: raw bytes as a binary string
}

const WORKSPACE = "/workspace/home";

/** Single-quote unescape: `'a'\''b'` → `a'b`, concatenating adjacent quotes. */
function parseShellTokens(command: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	const n = command.length;
	while (i < n) {
		while (i < n && /\s/.test(command[i] as string)) i++;
		if (i >= n) break;
		let token = "";
		while (i < n && !/\s/.test(command[i] as string)) {
			const ch = command[i] as string;
			if (ch === "'") {
				i++;
				while (i < n && command[i] !== "'") {
					token += command[i];
					i++;
				}
				i++; // closing quote
			} else {
				token += ch;
				i++;
			}
		}
		tokens.push(token);
	}
	return tokens;
}

class InMemoryBox implements UpstashBoxInstance {
	readonly id: string;
	cwd = WORKSPACE;
	fs = new Map<string, FsNode>();
	/** Captured timeout seconds from the most recent `timeout Ns …` exec wrap. */
	lastTimeoutSecs: number | undefined;
	/** Force the next exec.command call to throw box-gone once. */
	throwGoneOnce = false;
	deleted = false;

	constructor(id: string) {
		this.id = id;
		this.fs.set(WORKSPACE, { dir: true });
		this.fs.set("/workspace", { dir: true });
		this.fs.set("/", { dir: true });
	}

	files = {
		read: async (p: string, options?: { encoding?: "base64" }): Promise<string> => {
			const node = this.fs.get(p);
			if (!node || node.dir) throw new Error(`ENOENT: ${p}`);
			const raw = node.content ?? "";
			if (options?.encoding === "base64") {
				return Buffer.from(raw, "binary").toString("base64");
			}
			return raw;
		},
		write: async (options: {
			path: string;
			content: string;
			encoding?: "base64";
		}): Promise<void> => {
			const parent = options.path.replace(/\/[^/]*$/, "") || "/";
			if (!this.fs.get(parent)?.dir) {
				throw new Error(`ENOENT: missing parent ${parent}`);
			}
			const raw =
				options.encoding === "base64"
					? Buffer.from(options.content, "base64").toString("binary")
					: options.content;
			this.fs.set(options.path, { dir: false, content: raw });
		},
		list: async (p?: string): Promise<
			{ name: string; path: string; size: number; is_dir: boolean; mod_time: string }[]
		> => {
			const base = p ?? this.cwd;
			const prefix = base === "/" ? "/" : `${base}/`;
			const names = new Set<string>();
			for (const key of this.fs.keys()) {
				if (key === base) continue;
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.includes("/")) continue;
				names.add(rest);
			}
			return [...names].map((name) => {
				const full = prefix === "/" ? `/${name}` : `${prefix}${name}`;
				const node = this.fs.get(full);
				return {
					name,
					path: full,
					size: node?.content?.length ?? 0,
					is_dir: !!node?.dir,
					mod_time: "0",
				};
			});
		},
	};

	exec = {
		command: async (command: string): Promise<{ result: string; exitCode: number | null }> => {
			if (this.throwGoneOnce) {
				this.throwGoneOnce = false;
				const err = new Error("box not found") as Error & { statusCode?: number; name: string };
				err.name = "BoxError";
				err.statusCode = 404;
				throw err;
			}
			return this.run(command);
		},
	};

	private run(command: string): { result: string; exitCode: number | null } {
		// timeout <N>s bash -lc "$(echo '<b64>' | base64 -d)"
		const timeoutMatch = command.match(/^timeout\s+(\d+)s\s+bash\s+-lc\s+"(.*)"$/s);
		if (timeoutMatch) {
			this.lastTimeoutSecs = Number.parseInt(timeoutMatch[1] as string, 10);
			const inner = timeoutMatch[2] as string;
			const b64Match = inner.match(/echo\s+'([^']*)'\s*\|\s*base64\s+-d/);
			if (b64Match) {
				const script = Buffer.from(b64Match[1] as string, "base64").toString("utf8");
				return this.runScript(script);
			}
			return { result: "", exitCode: 0 };
		}
		return this.runScript(command);
	}

	/** Tiny interpreter for the stat/test/mkdir/rm shell-outs + cd/export/echo. */
	private runScript(script: string): { result: string; exitCode: number | null } {
		let out = "";
		let cwd = this.cwd;
		const statements = script.split("\n");
		for (const raw of statements) {
			const line = raw.trim();
			if (line === "") continue;

			// cd <path>
			const cd = line.match(/^cd\s+(.+)$/);
			if (cd) {
				cwd = parseShellTokens(line)[1] as string;
				if (!this.fs.get(cwd)?.dir) return { result: `cd: ${cwd}`, exitCode: 1 };
				continue;
			}

			// export KEY=VALUE — no-op for the interpreter
			if (line.startsWith("export ")) continue;

			// stat -L -c '%s/%Y/%F' <path> && stat -c '%F' <path>
			if (line.startsWith("stat ")) {
				return this.runStat(line);
			}

			// test -e <path> && echo 1 || echo 0
			if (line.startsWith("test -e ")) {
				const tokens = parseShellTokens(line);
				const target = tokens[2] as string;
				return { result: this.fs.has(this.abs(cwd, target)) ? "1" : "0", exitCode: 0 };
			}

			// mkdir [-p] <path>
			if (line.startsWith("mkdir ")) {
				return this.runMkdir(line, cwd);
			}

			// rm [-r] [-f] <path>
			if (line.startsWith("rm ")) {
				return this.runRm(line, cwd);
			}

			// echo <text...>
			const echo = line.match(/^echo\s+(.*)$/);
			if (echo) {
				const tokens = parseShellTokens(line).slice(1);
				out += `${tokens.join(" ")}\n`;
				continue;
			}

			return { result: `unsupported command: ${line}`, exitCode: 127 };
		}
		return { result: out, exitCode: 0 };
	}

	private abs(cwd: string, p: string): string {
		if (p.startsWith("/")) return p;
		return cwd === "/" ? `/${p}` : `${cwd}/${p}`;
	}

	private runStat(line: string): { result: string; exitCode: number | null } {
		const tokens = parseShellTokens(line);
		// stat -L -c <fmt> <path> ; the path is the last token before &&. Our
		// adapter always uses the same single path for both stats.
		const path = tokens[tokens.length - 1] as string;
		const node = this.fs.get(path);
		if (!node) return { result: `stat: ${path}: No such file`, exitCode: 1 };
		const type = node.dir ? "directory" : "regular file";
		const size = node.content?.length ?? 0;
		// `%s/%Y/%F\nregular file` shape the adapter parses.
		return { result: `${size}/0/${type}\n${type}`, exitCode: 0 };
	}

	private runMkdir(line: string, cwd: string): { result: string; exitCode: number | null } {
		const tokens = parseShellTokens(line);
		const recursive = tokens.includes("-p");
		const target = this.abs(cwd, tokens[tokens.length - 1] as string);
		if (this.fs.has(target)) return { result: "", exitCode: 0 };
		const parent = target.replace(/\/[^/]*$/, "") || "/";
		if (!this.fs.get(parent)?.dir) {
			if (!recursive) return { result: `mkdir: ${target}: parent missing`, exitCode: 1 };
			// create parents
			const parts = target.split("/").filter(Boolean);
			let acc = "";
			for (const part of parts) {
				acc += `/${part}`;
				if (!this.fs.has(acc)) this.fs.set(acc, { dir: true });
			}
			return { result: "", exitCode: 0 };
		}
		this.fs.set(target, { dir: true });
		return { result: "", exitCode: 0 };
	}

	private runRm(line: string, cwd: string): { result: string; exitCode: number | null } {
		const tokens = parseShellTokens(line);
		const recursive = tokens.includes("-r");
		const force = tokens.includes("-f");
		const target = this.abs(cwd, tokens[tokens.length - 1] as string);
		const node = this.fs.get(target);
		if (!node) {
			return force ? { result: "", exitCode: 0 } : { result: `rm: ${target}`, exitCode: 1 };
		}
		if (node.dir) {
			if (!recursive) return { result: `rm: ${target}: is a directory`, exitCode: 1 };
			const prefix = `${target}/`;
			for (const key of [...this.fs.keys()]) {
				if (key === target || key.startsWith(prefix)) this.fs.delete(key);
			}
			return { result: "", exitCode: 0 };
		}
		this.fs.delete(target);
		return { result: "", exitCode: 0 };
	}

	async cd(p: string): Promise<void> {
		this.cwd = p;
	}

	async delete(): Promise<void> {
		this.deleted = true;
	}
}

// ─── Fake client seam ─────────────────────────────────────────────────────────

class FakeBoxClient implements UpstashBoxClient {
	boxes: InMemoryBox[] = [];
	createCalls = 0;
	listCalls = 0;
	getCalls = 0;

	/** Seed an already-existing (warm) box with the given name. */
	seed(name: string): InMemoryBox {
		const box = new InMemoryBox(`box-${this.boxes.length}`);
		(box as unknown as { name?: string }).name = name;
		this.boxes.push(box);
		return box;
	}

	async create(config?: { name?: string; size?: unknown; keepAlive?: boolean }): Promise<
		UpstashBoxInstance
	> {
		this.createCalls++;
		const box = new InMemoryBox(`box-${this.boxes.length}`);
		(box as unknown as { name?: string }).name = config?.name;
		this.boxes.push(box);
		return box;
	}

	async list(): Promise<UpstashBoxData[]> {
		this.listCalls++;
		return this.boxes.map((b) => ({ id: b.id, name: (b as unknown as { name?: string }).name }));
	}

	async get(boxId: string): Promise<UpstashBoxInstance> {
		this.getCalls++;
		const box = this.boxes.find((b) => b.id === boxId);
		if (!box) throw new Error(`box ${boxId} not found`);
		return box;
	}
}

const SANDBOX_NAME = "ctx-1:inst-1:default";

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("upstashBox", () => {
	let client: FakeBoxClient;

	beforeEach(() => {
		client = new FakeBoxClient();
	});

	it("provisions lazily — createSessionEnv touches no box", async () => {
		const factory = upstashBox({ client });
		await factory.createSessionEnv({ id: SANDBOX_NAME });
		expect(client.createCalls).toBe(0);
		expect(client.listCalls).toBe(0);
		expect(client.getCalls).toBe(0);
	});

	it("exec('echo hi') provisions on first call and returns stdout", async () => {
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		expect(client.listCalls).toBe(0);

		const result = await env.exec("echo hi");
		expect(result.stdout).toBe("hi\n");
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);

		// First op resolved the box: list (no match) → create.
		expect(client.listCalls).toBe(1);
		expect(client.createCalls).toBe(1);
	});

	it("round-trips writeFile → readFile → stat → readdir → rm", async () => {
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });

		await env.writeFile("note.txt", "content");
		expect(await env.readFile("note.txt")).toBe("content");

		const bytes = await env.readFileBuffer("note.txt");
		expect(new TextDecoder().decode(bytes)).toBe("content");

		const stat = await env.stat("note.txt");
		expect(stat.isFile).toBe(true);
		expect(stat.isDirectory).toBe(false);
		expect(stat.size).toBe(7);

		expect(await env.exists("note.txt")).toBe(true);
		expect(await env.exists("missing.txt")).toBe(false);

		const entries = await env.readdir(".");
		expect(entries).toContain("note.txt");

		await env.rm("note.txt");
		expect(await env.exists("note.txt")).toBe(false);
	});

	it("auto-creates parent dirs on writeFile (writeFileCreatingParents)", async () => {
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await env.writeFile("a/b/c.txt", "deep");
		expect(await env.readFile("a/b/c.txt")).toBe("deep");
	});

	it("by-name: resolves a warm box via get, not create; caches within the action", async () => {
		client.seed(SANDBOX_NAME);
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });

		await env.exec("echo hi");
		expect(client.getCalls).toBe(1);
		expect(client.createCalls).toBe(0);
		expect(client.listCalls).toBe(1);

		// Second op within the same action reuses the cached handle: no re-list/get.
		await env.exec("echo hi");
		expect(client.listCalls).toBe(1);
		expect(client.getCalls).toBe(1);
	});

	it("cold factory re-resolves by name (handles do not survive actions)", async () => {
		client.seed(SANDBOX_NAME);

		const env1 = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await env1.exec("echo hi");
		expect(client.listCalls).toBe(1);

		// A fresh factory instance = a cold action: it re-resolves by name.
		const env2 = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await env2.exec("echo hi");
		expect(client.listCalls).toBe(2);
		expect(client.getCalls).toBe(2);
	});

	it("box-gone: a vanished cached handle re-provisions and succeeds", async () => {
		const seeded = client.seed(SANDBOX_NAME);
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });

		await env.exec("echo hi"); // warms the cache
		expect(client.getCalls).toBe(1);

		// Next op throws box-gone once; adapter clears cache + re-resolves.
		seeded.throwGoneOnce = true;
		const result = await env.exec("echo hi");
		expect(result.stdout).toBe("hi\n");
		// Re-resolution: a second list + get (still the same warm box).
		expect(client.listCalls).toBe(2);
		expect(client.getCalls).toBe(2);
	});

	it("rejects ../-escape on read and exec cwd", async () => {
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await expect(env.readFile("../secret")).rejects.toBeInstanceOf(
			SandboxOperationUnsupportedError,
		);
		await expect(env.exec("cat x", { cwd: "../.." })).rejects.toBeInstanceOf(
			SandboxOperationUnsupportedError,
		);
		await expect(env.stat("a/../../b")).rejects.toBeInstanceOf(SandboxOperationUnsupportedError);
		await expect(env.readFile("/etc/passwd")).rejects.toBeInstanceOf(
			SandboxOperationUnsupportedError,
		);
	});

	it("timeoutMs rounds UP to box-seconds (1500ms ⇒ 2s)", async () => {
		const seeded = client.seed(SANDBOX_NAME);
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await env.exec("echo hi", { timeoutMs: 1500 });
		expect(seeded.lastTimeoutSecs).toBe(2);
	});

	it("default timeout is 30 box-seconds when none supplied", async () => {
		const seeded = client.seed(SANDBOX_NAME);
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });
		await env.exec("echo hi");
		expect(seeded.lastTimeoutSecs).toBe(30);
	});

	it("raises SandboxOperationUnsupportedError when the box cannot service an op (partial impl)", async () => {
		// A genuinely partial backend: it provisions a box that does not implement
		// directory listing at all. readdir cannot be serviced → unsupported.
		const partial: UpstashBoxClient = {
			create: async () => {
				const box = new InMemoryBox("partial");
				(box as unknown as { name?: string }).name = SANDBOX_NAME;
				// Drop files.list — the backend has no directory-listing capability.
				(box as unknown as { files: Record<string, unknown> }).files = {
					read: box.files.read,
					write: box.files.write,
					list: undefined,
				};
				return box;
			},
			list: async () => [],
			get: async () => {
				throw new Error("partial client: get should not be called");
			},
		};
		const env = await upstashBox({ client: partial }).createSessionEnv({ id: SANDBOX_NAME });
		await expect(env.readdir(".")).rejects.toBeInstanceOf(SandboxOperationUnsupportedError);
	});

	it("ordinary shell-out failures are OperationFailedError, not 'unsupported'", async () => {
		// A missing file / already-existing dir / missing rm target are normal
		// operation failures (node-fs parity), never SandboxOperationUnsupportedError.
		const env = await upstashBox({ client }).createSessionEnv({ id: SANDBOX_NAME });

		await expect(env.stat("nope.txt")).rejects.toBeInstanceOf(OperationFailedError);
		await expect(env.stat("nope.txt")).rejects.not.toBeInstanceOf(SandboxOperationUnsupportedError);

		await expect(env.rm("nope.txt")).rejects.toBeInstanceOf(OperationFailedError);
		// rm with force on a missing path is a no-op (does not throw).
		await expect(env.rm("nope.txt", { force: true })).resolves.toBeUndefined();
	});
});
