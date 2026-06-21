"use node";
// New (Convex backend, real-machine adapter) · @cove/runtime · consumes BashFactory/BashLike per flue sandbox.ts + D7
// Pattern source: flue sandbox.ts (`bash()`/`createBashSessionEnv` consume a
// caller-supplied BashFactory). flue had no concrete in-process adapter — its
// real-machine path took a just-bash runtime. Cove ships a default BashLike
// over Node `fs/promises` + `child_process` so `bash()` has a real machine to
// drive out of the box (D7 — the built-in real-machine target).
//
// The factory wraps the resulting SessionEnv in createCwdSessionEnv so the
// §3 workspace-escape rejection applies to the real machine too. A real-machine
// adapter that can't confine must raise SandboxOperationUnsupportedError — here
// confinement is provided by createCwdSessionEnv, so it always can.

import { spawn } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { BashFactory, BashLike, FileStat, SandboxFactory, ShellResult } from "../../src/runtime/types.ts";
import { bash, createCwdSessionEnv } from "./sessionEnv.ts";

/** Map a Node `fs.Stats` to a {@link FileStat}, never fabricating fields. */
function toFileStat(stats: import("node:fs").Stats): FileStat {
	return {
		isFile: stats.isFile(),
		isDirectory: stats.isDirectory(),
		isSymbolicLink: stats.isSymbolicLink(),
		size: stats.size,
		mtime: stats.mtime,
	};
}

/**
 * A concrete {@link BashLike} over Node `fs/promises` + `child_process`. The
 * workspace root (`cwd`) is the spawn working directory and the `getCwd()`
 * value the SessionEnv resolves relative paths against.
 */
export function nodeBashLike(cwd: string): BashLike {
	const root = path.resolve(cwd);

	return {
		exec(
			command: string,
			options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
		): Promise<ShellResult> {
			return new Promise<ShellResult>((resolve) => {
				const child = spawn("bash", ["-lc", command], {
					cwd: options?.cwd ?? root,
					env: options?.env ? { ...process.env, ...options.env } : process.env,
					signal: options?.signal,
				});

				let stdout = "";
				let stderr = "";
				child.stdout?.on("data", (chunk) => {
					stdout += chunk.toString();
				});
				child.stderr?.on("data", (chunk) => {
					stderr += chunk.toString();
				});

				// Spawn error / signal-kill → exit -1 sentinel (never throws so the
				// caller observes a ShellResult, matching the box adapter).
				child.on("error", () => {
					resolve({ stdout, stderr, exitCode: -1 });
				});
				child.on("close", (code) => {
					resolve({ stdout, stderr, exitCode: code ?? -1 });
				});
			});
		},

		getCwd(): string {
			return root;
		},

		fs: {
			readFile: (p: string) => fsp.readFile(p, "utf8"),
			readFileBuffer: async (p: string): Promise<Uint8Array> => {
				const buf = await fsp.readFile(p);
				return new Uint8Array(buf);
			},
			writeFile: (p: string, content: string | Uint8Array) =>
				fsp.writeFile(p, content as Parameters<typeof fsp.writeFile>[1]),
			stat: async (p: string): Promise<FileStat> => toFileStat(await fsp.stat(p)),
			readdir: (p: string) => fsp.readdir(p),
			exists: async (p: string): Promise<boolean> => {
				try {
					await fsp.access(p);
					return true;
				} catch {
					return false;
				}
			},
			mkdir: async (p: string, options?: { recursive?: boolean }): Promise<void> => {
				await fsp.mkdir(p, options);
			},
			rm: (p: string, options?: { recursive?: boolean; force?: boolean }) => fsp.rm(p, options),
			resolvePath: (base: string, p: string) => path.resolve(base, p),
		},
	};
}

export interface LocalBashOptions {
	/** Workspace root. Defaults to the process cwd. */
	cwd?: string;
	/** Override the BashFactory (default = a {@link nodeBashLike} over Node). */
	bashFactory?: BashFactory;
}

/**
 * Build a {@link SandboxFactory} that runs on the real local machine via an
 * in-process `bash`. The resulting SessionEnv is wrapped in
 * {@link createCwdSessionEnv} so workspace-escape rejection (08 §3) applies to
 * the real machine too.
 */
export function localBash(options?: LocalBashOptions): SandboxFactory {
	const workspaceCwd = path.resolve(options?.cwd ?? process.cwd());
	const factory: BashFactory = options?.bashFactory ?? (() => nodeBashLike(workspaceCwd));
	const inner = bash(factory);

	return {
		async createSessionEnv(args: { id: string }) {
			const env = await inner.createSessionEnv(args);
			return createCwdSessionEnv(env, workspaceCwd);
		},
	};
}
