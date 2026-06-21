// Ported from flue · @flue/runtime · packages/runtime/src/sandbox.ts → @cove/runtime
// Verbatim port of the path/scaffolding helpers (normalizePath, posixParentDir,
// makeResolvePath, writeFileCreatingParents, createCwdSessionEnv,
// createSandboxSessionEnv, SandboxApi, bash, bashFactoryToSessionEnv,
// createBashSessionEnv, isBashLike, assertBashLike). '[flue]' → '[cove]'.
// createFlueFs is NOT ported here.
// TODO(P6): CoveFs adapter (the `createFlueFs` equivalent) lands with the
// harness.fs/session.fs facade, not in this phase.
//
// CORRECTNESS DELTA vs flue (plan task 3): flue's normalizePath silently
// collapses `..` (pops the stack), so `../../etc` would resolve above `cwd`
// with no error. The roadmap requires rejection. `resolveWithinWorkspace`
// (below) asserts the resolved path stays at/under `cwd` and throws
// SandboxOperationUnsupportedError otherwise; makeResolvePath routes through
// it so EVERY SessionEnv method rejects escapes.
//
// Pure module — NO "use node", no box/fs import (must stay V8-safe so it can
// be imported from anywhere).

import { abortErrorFor, composeTimeoutSignal } from "./abort.ts";
import { SandboxOperationUnsupportedError } from "../../src/runtime/errors.ts";
import type {
	BashFactory,
	BashLike,
	FileStat,
	SandboxFactory,
	SessionEnv,
	ShellResult,
} from "../../src/runtime/types.ts";

export type { SessionEnv } from "../../src/runtime/types.ts";

/**
 * Shared implementation of the `CoveFs.writeFile` parent-creation guarantee.
 * Every `SessionEnv` adapter (local, bash factory, SandboxApi wrapper) routes
 * writes through here so the cross-mode contract has exactly one
 * implementation.
 *
 * Lazy by design: try the write first so the happy path costs a single call
 * (no extra remote round-trip per write). When the write fails — most often a
 * missing parent directory — `mkdir -p` the parent and retry once. Mkdir
 * errors are ignored so that when the original failure was something else
 * entirely, the retry reproduces it and its error propagates unchanged.
 */
export async function writeFileCreatingParents(
	write: () => Promise<void>,
	mkdirParent: () => Promise<unknown>,
): Promise<void> {
	try {
		await write();
		return;
	} catch {
		// Fall through to parent creation + retry.
	}
	try {
		await mkdirParent();
	} catch {
		// Ignore: the retried write's error is the authoritative failure.
	}
	await write();
}

/** Parent directory of an absolute POSIX path (`/a/b.txt` → `/a`, `/a.txt` → `/`). */
export function posixParentDir(p: string): string {
	return p.replace(/\/[^/]*$/, "") || "/";
}

/** Collapse `.`/`..`/empty segments of a POSIX path into a normalized absolute path. */
export function normalizePath(p: string): string {
	const parts = p.split("/");
	const result: string[] = [];
	for (const part of parts) {
		if (part === "." || part === "") continue;
		if (part === "..") {
			result.pop();
		} else {
			result.push(part);
		}
	}
	return `/${result.join("/")}`;
}

/**
 * Resolve `p` against `cwd` and assert the result stays inside the workspace.
 *
 * flue's `normalizePath` pops on `..` and never errors, so `../../etc` would
 * silently resolve to `/etc`. This is the explicit boundary the roadmap
 * requires: after normalization, the path must be `cwd` itself or a descendant
 * (`cwd + '/'`-prefixed). Anything else — `../`, `../../`, an absolute path
 * outside `cwd`, or a sneaky `a/../../b` — throws.
 */
export function resolveWithinWorkspace(cwd: string, p: string): string {
	const root = normalizePath(cwd);
	const resolved = p.startsWith("/")
		? normalizePath(p)
		: root === "/"
			? normalizePath(`/${p}`)
			: normalizePath(`${root}/${p}`);
	if (resolved === root || resolved.startsWith(root === "/" ? "/" : `${root}/`)) {
		return resolved;
	}
	throw new SandboxOperationUnsupportedError(`path escapes workspace: ${p}`);
}

/**
 * Resolve a possibly-relative POSIX path against `cwd`, normalizing the result
 * and rejecting any path that escapes the workspace (see
 * {@link resolveWithinWorkspace}).
 */
function makeResolvePath(cwd: string): (p: string) => string {
	const root = normalizePath(cwd);
	return (p: string): string => resolveWithinWorkspace(root, p);
}

export function createCwdSessionEnv(parentEnv: SessionEnv, cwd: string): SessionEnv {
	const scopedCwd = normalizePath(cwd);
	const resolvePath = makeResolvePath(scopedCwd);

	return {
		exec: (cmd, opts) =>
			parentEnv.exec(cmd, {
				cwd: opts?.cwd !== undefined ? resolvePath(opts.cwd) : scopedCwd,
				env: opts?.env,
				timeoutMs: opts?.timeoutMs,
				signal: opts?.signal,
			}),
		readFile: (p) => parentEnv.readFile(resolvePath(p)),
		readFileBuffer: (p) => parentEnv.readFileBuffer(resolvePath(p)),
		writeFile: (p, c) => parentEnv.writeFile(resolvePath(p), c),
		stat: (p) => parentEnv.stat(resolvePath(p)),
		readdir: (p) => parentEnv.readdir(resolvePath(p)),
		exists: (p) => parentEnv.exists(resolvePath(p)),
		mkdir: (p, o) => parentEnv.mkdir(resolvePath(p), o),
		rm: (p, o) => parentEnv.rm(resolvePath(p), o),
		cwd: scopedCwd,
		resolvePath,
	};
}

/**
 * Wrap a just-bash factory into a {@link SandboxFactory}:
 * `createAgent(() => ({ sandbox: bash(() => new Bash({ fs })) }))`.
 */
export function bash(factory: BashFactory): SandboxFactory {
	return {
		createSessionEnv: () => bashFactoryToSessionEnv(factory),
	};
}

export async function bashFactoryToSessionEnv(factory: BashFactory): Promise<SessionEnv> {
	const bash = await factory();
	assertBashLike(bash);
	return createBashSessionEnv(bash);
}

function createBashSessionEnv(bash: BashLike): SessionEnv {
	const fs = bash.fs;
	const cwd = bash.getCwd();
	const resolve = (p: string) => (p.startsWith("/") ? p : fs.resolvePath(cwd, p));

	return {
		exec: async (cmd, opts) => {
			// Pre/post abort checks here — mirrors the sandbox and local
			// adapters, so a Bash-like implementation that ignores
			// AbortSignal still never executes on a pre-aborted call.
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);

			// Just-bash has no native timeout option. Translate `timeoutMs`
			// into an AbortSignal and compose with the caller's signal so
			// bash factories observe deadlines with the same fidelity as
			// signal-aware sandbox adapters.
			const { mergedSignal } = composeTimeoutSignal(opts?.timeoutMs, opts?.signal);

			const result = await bash.exec(
				cmd,
				opts ? { cwd: opts.cwd, env: opts.env, signal: mergedSignal } : undefined,
			);
			if (opts?.signal?.aborted) throw abortErrorFor(opts.signal);
			return result;
		},
		readFile: (p) => fs.readFile(resolve(p)),
		readFileBuffer: (p) => fs.readFileBuffer(resolve(p)),
		writeFile: (p, content) => {
			const resolved = resolve(p);
			return writeFileCreatingParents(
				() => fs.writeFile(resolved, content),
				() => fs.mkdir(posixParentDir(resolved), { recursive: true }),
			);
		},
		stat: (p) => fs.stat(resolve(p)),
		readdir: (p) => fs.readdir(resolve(p)),
		exists: (p) => fs.exists(resolve(p)),
		mkdir: (p, o) => fs.mkdir(resolve(p), o),
		rm: (p, o) => fs.rm(resolve(p), o),
		cwd,
		resolvePath: resolve,
	};
}

/** Duck-type detection for just-bash Bash instances. */
function isBashLike(value: unknown): value is BashLike {
	return (
		typeof value === "object" &&
		value !== null &&
		"exec" in value &&
		"getCwd" in value &&
		"fs" in value &&
		typeof (value as any).exec === "function" &&
		typeof (value as any).getCwd === "function" &&
		// `typeof null === 'object'`, so an explicit null-check is required here.
		typeof (value as any).fs === "object" &&
		(value as any).fs !== null
	);
}

function assertBashLike(value: unknown): asserts value is BashLike {
	if (!isBashLike(value)) {
		throw new Error("[cove] BashFactory must return a Bash-like object.");
	}
}

/**
 * Interface that remote sandbox providers must implement.
 *
 * `exec()` cancellation is expressed two ways. Sandbox adapters should honor at
 * least one — preferably `timeoutMs`, since most provider SDKs expose a
 * native timeout option but few support mid-flight cancellation:
 *
 *   - `timeoutMs?: number` (milliseconds): the **primary** cancellation
 *     contract. Forward to the provider's native timeout option. Providers
 *     with coarser granularity may round the value up, never down.
 *     Required for parity with the LLM bash tool, which always passes a
 *     deadline hint when the model requests one.
 *   - `signal?: AbortSignal` (optional): for sandbox adapters whose SDK supports
 *     mid-flight cancellation (in-process bash). Lets programmatic callers do
 *     ad-hoc `abort()`. Sandbox adapters that can't honor it should ignore it;
 *     the deadline is still enforced via `timeoutMs`.
 *
 * Sandbox adapters that support both should observe whichever fires first.
 */
export interface SandboxApi {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
	exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeoutMs?: number;
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;
}

/** Wrap a SandboxApi into SessionEnv. No just-bash, no intermediate filesystem layer. */
export function createSandboxSessionEnv(api: SandboxApi, cwd: string): SessionEnv {
	const resolvePath = makeResolvePath(cwd);
	const scopedCwd = normalizePath(cwd);

	return {
		async exec(
			command: string,
			options?: {
				cwd?: string;
				env?: Record<string, string>;
				timeoutMs?: number;
				signal?: AbortSignal;
			},
		): Promise<ShellResult> {
			// Pre/post abort checks here — not in every sandbox adapter. Most
			// provider SDKs (including @upstash/box) don't accept an
			// AbortSignal, so a caller that aborts during a long-running
			// remote command would otherwise see the call return
			// successfully and the abort silently dropped. Centralizing the
			// check means sandbox adapters only need to wire `signal` into their
			// provider SDK when one supports it; the rest get correct abort
			// semantics for free.
			const signal = options?.signal;
			if (signal?.aborted) throw abortErrorFor(signal);
			const result = await api.exec(command, {
				cwd: options?.cwd !== undefined ? resolvePath(options.cwd) : scopedCwd,
				env: options?.env,
				timeoutMs: options?.timeoutMs,
				signal,
			});
			if (signal?.aborted) throw abortErrorFor(signal);
			return result;
		},

		async readFile(path: string): Promise<string> {
			return api.readFile(resolvePath(path));
		},

		async readFileBuffer(path: string): Promise<Uint8Array> {
			return api.readFileBuffer(resolvePath(path));
		},

		async writeFile(path: string, content: string | Uint8Array): Promise<void> {
			const resolved = resolvePath(path);
			return writeFileCreatingParents(
				() => api.writeFile(resolved, content),
				() => api.mkdir(posixParentDir(resolved), { recursive: true }),
			);
		},

		async stat(path: string): Promise<FileStat> {
			return api.stat(resolvePath(path));
		},

		async readdir(path: string): Promise<string[]> {
			return api.readdir(resolvePath(path));
		},

		async exists(path: string): Promise<boolean> {
			return api.exists(resolvePath(path));
		},

		async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
			return api.mkdir(resolvePath(path), options);
		},

		async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
			return api.rm(resolvePath(path), options);
		},

		cwd: scopedCwd,

		resolvePath,
	};
}
