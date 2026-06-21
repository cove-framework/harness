"use node";
// New (Convex backend) · @cove/runtime · adapts @upstash/box to SandboxApi from flue sandbox.ts
// Pattern source: flue cloudflare/cf-sandbox.ts (the stat/readdir shell-out
// idioms + the `rm` unsupported-option → raise guard). @upstash/box exposes no
// native stat/exists/mkdir/rm, so those are shelled out via box.exec.command.
//
// Owns: lazy provisioning (no box until the first op), by-name resolution
// (Box.list → match name → Box.get; else Box.create), a per-action warm-handle
// cache (within one action only — boxes outlive stateless actions, handles do
// not, R5), box-gone re-resolve-once, base64 `bash -l` exec with a coreutil
// `timeout` wrap (ceil to box-seconds, never down), and
// SandboxOperationUnsupportedError for unservable ops.
//
// env redaction (08 §4.11 / D19): this adapter must never log or persist `env`
// values — redaction happens in the shell envelope (P6), not here.

import { Box } from "@upstash/box";
import type { BoxSize, FileEntry } from "@upstash/box";
import { OperationFailedError, SandboxOperationUnsupportedError } from "../../src/runtime/errors.ts";
import type { FileStat, SandboxFactory, SessionEnv, ShellResult } from "../../src/runtime/types.ts";
import { createSandboxSessionEnv, type SandboxApi } from "./sessionEnv.ts";

/** A single shell `Run` result as the SandboxApi cares about it. */
interface BoxRunLike {
	/** stdout string. */
	result: string;
	/** Process exit code; null for agent runs (we only run commands). */
	exitCode: number | null;
}

/** A resolved box instance — the subset of `Box` this adapter calls. */
export interface UpstashBoxInstance {
	readonly id: string;
	readonly cwd: string;
	cd(path: string): Promise<void>;
	files: {
		read(path: string, options?: { encoding?: "base64" }): Promise<string>;
		write(options: { path: string; content: string; encoding?: "base64" }): Promise<void>;
		list(path?: string): Promise<FileEntry[]>;
	};
	exec: {
		command(command: string): Promise<BoxRunLike>;
	};
	delete(): Promise<void>;
}

/** Box-record subset returned by `Box.list()` used for by-name matching. */
export interface UpstashBoxData {
	id: string;
	name?: string;
}

/**
 * Injectable seam over the @upstash/box `Box` static class. Default = the real
 * `Box`. Tests substitute an in-memory fake so no live Upstash box or network
 * is touched. Mirrors P3's `MockLanguageModelV2` injection pattern.
 */
export interface UpstashBoxClient {
	create(config?: {
		name?: string;
		size?: BoxSize;
		keepAlive?: boolean;
		[key: string]: unknown;
	}): Promise<UpstashBoxInstance>;
	list(options?: Record<string, unknown>): Promise<UpstashBoxData[]>;
	get(boxId: string, options?: Record<string, unknown>): Promise<UpstashBoxInstance>;
}

/** Default client = the real `Box` static class. */
const realBoxClient: UpstashBoxClient = {
	create: (config) => Box.create(config) as unknown as Promise<UpstashBoxInstance>,
	list: (options) => Box.list(options) as unknown as Promise<UpstashBoxData[]>,
	get: (boxId, options) => Box.get(boxId, options) as unknown as Promise<UpstashBoxInstance>,
};

export interface UpstashBoxOptions {
	/** Workspace root inside the box. Defaults to the box session root `/workspace/home`. */
	cwd?: string;
	/** Resource size used when provisioning. Defaults to `"small"` (the SDK default). */
	size?: BoxSize;
	/** Injectable client seam (default = real `Box`). Tests pass a fake. */
	client?: UpstashBoxClient;
}

/** Box session root — every new box session starts here (see `Box.cwd`). */
const DEFAULT_WORKSPACE_CWD = "/workspace/home";
/** Adapter default exec deadline when the caller passes no `timeoutMs` (08 §4.2). */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Single-quote escape idiom for embedding an arbitrary path in a shell command. */
function shQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Heuristic: is this error a "box no longer exists" failure (re-resolve trigger)? */
function isBoxGone(error: unknown): boolean {
	if (error == null || typeof error !== "object") return false;
	const e = error as { statusCode?: unknown; name?: unknown; message?: unknown };
	if (e.statusCode === 404) return true;
	if (e.name === "BoxError" && typeof e.message === "string") {
		return /not\s*found|404|does not exist/i.test(e.message);
	}
	return false;
}

/** base64 of a UTF-8 string (Node Buffer is available under "use node"). */
function toBase64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64");
}

/** decode a base64 string into a Uint8Array. */
function fromBase64ToBytes(b64: string): Uint8Array {
	return new Uint8Array(Buffer.from(b64, "base64"));
}

/**
 * Lazy by-name box resolver with a per-action handle cache and box-gone
 * re-resolve-once. The cache lives only for the lifetime of this closure
 * (one action); a cold action constructs a fresh resolver and re-resolves by
 * name. Never persisted across actions (R5).
 */
function createBoxResolver(client: UpstashBoxClient, sandboxName: string, size: BoxSize | undefined) {
	let cached: UpstashBoxInstance | undefined;

	async function resolve(): Promise<UpstashBoxInstance> {
		const boxes = await client.list();
		const match = boxes.find((b) => b.name === sandboxName);
		if (match) {
			return client.get(match.id);
		}
		return client.create({ name: sandboxName, keepAlive: true, size });
	}

	async function getBox(): Promise<UpstashBoxInstance> {
		if (cached === undefined) {
			cached = await resolve();
		}
		return cached;
	}

	/**
	 * Run `fn` against the resolved box. If the box is gone, clear the cache,
	 * re-resolve once, and retry. A second box-gone failure propagates.
	 */
	async function withBox<T>(fn: (box: UpstashBoxInstance) => Promise<T>): Promise<T> {
		const box = await getBox();
		try {
			return await fn(box);
		} catch (error) {
			if (!isBoxGone(error)) throw error;
			cached = undefined;
			const fresh = await getBox();
			return fn(fresh);
		}
	}

	return { withBox };
}

/**
 * Build a {@link SandboxApi} over a resolved box. Path resolution, parent-dir
 * creation, and abort checks are layered on by {@link createSandboxSessionEnv}.
 */
function createBoxApi(
	resolver: ReturnType<typeof createBoxResolver>,
	defaultTimeoutMs: number,
): SandboxApi {
	const { withBox } = resolver;

	// Capability guard: a resolved box that does not expose a method the adapter
	// needs cannot service that SessionEnv op. This is the ONLY trigger for
	// SandboxOperationUnsupportedError — an ordinary non-zero shell exit (a
	// missing file, an already-existing dir) is a normal OperationFailedError,
	// never "unsupported" (plan 02 task 7; review fidelity note).
	function assertSupported(condition: unknown, op: string, why: string): asserts condition {
		if (!condition) {
			throw new SandboxOperationUnsupportedError(`upstashBox.${op}: ${why}`);
		}
	}

	async function run(box: UpstashBoxInstance, command: string): Promise<BoxRunLike> {
		assertSupported(
			typeof box.exec?.command === "function",
			"exec",
			"box does not support command execution",
		);
		return box.exec.command(command);
	}

	/**
	 * Run a shell-out and return stdout + exitCode. Does NOT throw on a non-zero
	 * exit — the caller decides what a non-zero exit means for its op (ordinary
	 * failure → OperationFailedError). A genuinely unservable box (no exec) still
	 * raises SandboxOperationUnsupportedError via `run`.
	 */
	async function shell(command: string): Promise<{ stdout: string; exitCode: number }> {
		return withBox(async (box) => {
			const result = await run(box, command);
			return { stdout: result.result ?? "", exitCode: result.exitCode ?? -1 };
		});
	}

	// Internal: run a fully-formed command line and map Run → ShellResult.
	// exec.command has no separate stderr stream; map result→stdout,
	// stderr='' (never fabricated), exitCode = run.exitCode ?? -1.
	function execRaw(command: string): Promise<ShellResult> {
		return withBox(async (box) => {
			const result = await run(box, command);
			return {
				stdout: result.result ?? "",
				stderr: "",
				exitCode: result.exitCode ?? -1,
			};
		});
	}

	return {
		async readFile(path: string): Promise<string> {
			return withBox((box) => {
				assertSupported(typeof box.files?.read === "function", "readFile", "box has no files.read");
				return box.files.read(path);
			});
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			const b64 = await withBox((box) => {
				assertSupported(
					typeof box.files?.read === "function",
					"readFileBuffer",
					"box has no files.read",
				);
				return box.files.read(path, { encoding: "base64" });
			});
			return fromBase64ToBytes(b64);
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			await withBox((box) => {
				assertSupported(
					typeof box.files?.write === "function",
					"writeFile",
					"box has no files.write",
				);
				if (typeof content === "string") {
					return box.files.write({ path, content });
				}
				const b64 = Buffer.from(content).toString("base64");
				return box.files.write({ path, content: b64, encoding: "base64" });
			});
		},

		async stat(path: string): Promise<FileStat> {
			const quoted = shQuote(path);
			// `stat -L` follows symlinks so isFile/isDirectory/size/mtime match
			// fs.stat semantics; the second (non-following) stat reports whether
			// the path itself is a symlink.
			const { stdout, exitCode } = await shell(
				`stat -L -c '%s/%Y/%F' ${quoted} && stat -c '%F' ${quoted}`,
			);
			if (exitCode !== 0) {
				throw new OperationFailedError(
					`upstashBox.stat: ${path}: ${stdout.trim() || `exited ${exitCode}`}`,
				);
			}
			const [target = "", self = ""] = stdout.trim().split("\n");
			const [size = "", mtime = "", type = ""] = target.split("/");
			const sizeNum = Number.parseInt(size, 10);
			const mtimeNum = Number.parseInt(mtime, 10);
			const result: FileStat = {
				isFile: type.includes("regular"),
				isDirectory: type === "directory",
				isSymbolicLink: self.trim() === "symbolic link",
			};
			// Never fabricate (FileStat contract): omit size/mtime if unparseable.
			if (!Number.isNaN(sizeNum)) result.size = sizeNum;
			if (!Number.isNaN(mtimeNum)) result.mtime = new Date(mtimeNum * 1000);
			return result;
		},

		async readdir(path: string): Promise<string[]> {
			const entries = await withBox((box) => {
				assertSupported(typeof box.files?.list === "function", "readdir", "box has no files.list");
				return box.files.list(path);
			});
			return entries.map((e) => e.name);
		},

		async exists(path: string): Promise<boolean> {
			// `test -e … && echo 1 || echo 0` always exits 0, so existence is read
			// off stdout — exists() never throws on a missing path.
			const { stdout } = await shell(`test -e ${shQuote(path)} && echo 1 || echo 0`);
			return stdout.trim() === "1";
		},

		async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
			const flag = options?.recursive ? "-p " : "";
			const { stdout, exitCode } = await shell(`mkdir ${flag}${shQuote(path)}`);
			if (exitCode !== 0) {
				throw new OperationFailedError(
					`upstashBox.mkdir: ${path}: ${stdout.trim() || `exited ${exitCode}`}`,
				);
			}
		},

		async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
			const flags = [
				options?.recursive ? "-r" : undefined,
				options?.force ? "-f" : undefined,
			].filter((f): f is string => f !== undefined);
			const flagStr = flags.length > 0 ? `${flags.join(" ")} ` : "";
			const { stdout, exitCode } = await shell(`rm ${flagStr}${shQuote(path)}`);
			if (exitCode !== 0) {
				throw new OperationFailedError(
					`upstashBox.rm: ${path}: ${stdout.trim() || `exited ${exitCode}`}`,
				);
			}
		},

		async exec(
			command: string,
			options?: {
				cwd?: string;
				env?: Record<string, string>;
				timeoutMs?: number;
				signal?: AbortSignal;
			},
		): Promise<ShellResult> {
			// timeoutMs → box seconds, rounded UP (never down — R5).
			const timeoutMs = options?.timeoutMs ?? defaultTimeoutMs;
			const ceilSecs = Math.max(1, Math.ceil(timeoutMs / 1000));

			// Build the inner script: cd into cwd, export env, run the command.
			const lines: string[] = [];
			if (options?.cwd) lines.push(`cd ${shQuote(options.cwd)}`);
			if (options?.env) {
				for (const [key, value] of Object.entries(options.env)) {
					lines.push(`export ${key}=${shQuote(value)}`);
				}
			}
			lines.push(command);
			const script = lines.join("\n");

			// base64 the script so multi-line/quoting-heavy commands survive
			// transport; decode + run under a login shell (`bash -l`) so the
			// box's PATH/env profile is loaded. The coreutil `timeout` enforces
			// the deadline since exec.command has no native timeout option.
			const b64 = toBase64(script);
			const wrapped = `timeout ${ceilSecs}s bash -lc "$(echo ${shQuote(b64)} | base64 -d)"`;

			return execRaw(wrapped);
		},
	};
}

/**
 * Build a {@link SandboxFactory} backed by @upstash/box.
 *
 * `createSessionEnv({ id })` returns a `SessionEnv` whose underlying box is
 * resolved **lazily** — no `Box.list`/`get`/`create` fires until the first
 * exec/fs op. The `id` is used as the box's `sandboxName` (the engine supplies
 * the composed `${ctx.id}:${instanceId}:${harnessName}` key in P4; this phase
 * accepts whatever name it is given).
 */
export function upstashBox(options?: UpstashBoxOptions): SandboxFactory {
	const client = options?.client ?? realBoxClient;
	const workspaceCwd = options?.cwd ?? DEFAULT_WORKSPACE_CWD;
	const size = options?.size;

	return {
		async createSessionEnv({ id }: { id: string }): Promise<SessionEnv> {
			const resolver = createBoxResolver(client, id, size);
			const api = createBoxApi(resolver, DEFAULT_TIMEOUT_MS);
			return createSandboxSessionEnv(api, workspaceCwd);
		},
	};
}
