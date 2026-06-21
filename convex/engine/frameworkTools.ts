// Ported from flue · @flue/runtime · packages/runtime/src/agent.ts → @cove/runtime
//   createTools' built-in set (read/write/edit/bash/grep/glob) reshaped from pi's AgentTool
//   (execute(toolCallId, params) → AgentToolResult) onto cove's EngineTool (execute(args) →
//   EngineToolResult). TypeBox `Type.Object` schemas → plain JSON Schema objects (cove's model view).
//   Helpers (truncateHead/truncateTail/countOccurrences/shellQuote/formatReadContent/formatBashResult)
//   ported verbatim; '[flue]' → '[cove]'.
//
//   DEFERRED (documented seams, not in P4): `task` (spawns a nested workflow — needs invoke/P6) and
//   `activate_skill` (resolves from the skills catalog — P10), plus the packaged-skill read branch
//   (PACKAGED_SKILLS_ROOT, packaged-skills authoring — P8.5). The buildTools machinery P4 must prove is
//   tool-roster-agnostic; these wire in behind it without changing the dispatch contract.
//
// Pure / V8-safe: binds to a SessionEnv (the box-ness lives in env, resolved by the "use node"
// dispatchTools action); imports only abort helpers + types. No box/AI SDK/Convex import here.

import { abortErrorFor, composeTimeoutSignal } from "../sandbox/abort.ts";
import { formatShellOutput } from "../../src/runtime/bash-output.ts";
import type { SessionEnv } from "../../src/runtime/types.ts";
import type { EngineTool, EngineToolResult } from "./types.ts";

const MAX_READ_LINES = 2000;
const MAX_READ_BYTES = 50 * 1024;
const MAX_GREP_MATCHES = 100;
const MAX_GREP_LINE_LENGTH = 500;
const MAX_GLOB_RESULTS = 1000;
/** Default exec deadline floor (doc 08 §4.2) so a no-timeout bash call still kills a runaway child. */
const DEFAULT_BASH_TIMEOUT_SEC = 30;

/** The built-in framework tools bound to a session's SessionEnv (fs/exec). */
export function createFrameworkTools(env: SessionEnv): EngineTool[] {
	return [
		createReadTool(env),
		createWriteTool(env),
		createEditTool(env),
		createBashTool(env),
		createGrepTool(env),
		createGlobTool(env),
	];
}

/** Names of the env-bound built-in tools (used by buildTools to reconstruct executables). */
export const FRAMEWORK_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "glob"] as const;
export type FrameworkToolName = (typeof FRAMEWORK_TOOL_NAMES)[number];

/** Reconstruct a single built-in tool by name, bound to env (buildTools kind="builtin"). */
export function createFrameworkTool(name: string, env: SessionEnv): EngineTool | undefined {
	switch (name) {
		case "read":
			return createReadTool(env);
		case "write":
			return createWriteTool(env);
		case "edit":
			return createEditTool(env);
		case "bash":
			return createBashTool(env);
		case "grep":
			return createGrepTool(env);
		case "glob":
			return createGlobTool(env);
		default:
			return undefined;
	}
}

// ─── read ─────────────────────────────────────────────────────────────────────

const ReadParams = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to read" },
		offset: { type: "number", description: "Line number to start from (1-indexed)" },
		limit: { type: "number", description: "Maximum number of lines to read" },
	},
	required: ["path"],
	additionalProperties: false,
} as const;

function createReadTool(env: SessionEnv): EngineTool {
	return {
		name: "read",
		description:
			"Read a file or list a directory. For files, output is truncated to 2000 lines or 50KB — use offset/limit for large files. For directories, returns the list of entries.",
		parameters: ReadParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const path = requireString(args, "path");
			const offset = optionalNumber(args, "offset");
			const limit = optionalNumber(args, "limit");

			try {
				const fileStat = await env.stat(path);
				if (fileStat.isDirectory) {
					const entries = await env.readdir(path);
					const listing = entries.join("\n");
					return text(listing || "(empty directory)", {
						path,
						isDirectory: true,
						entries: entries.length,
					});
				}
			} catch {
				// stat failed — fall through to readFile.
			}

			const content = await env.readFile(path);
			return formatReadContent(path, content, offset, limit);
		},
	};
}

// ─── write ────────────────────────────────────────────────────────────────────

const WriteParams = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to write" },
		content: { type: "string", description: "Content to write to the file" },
	},
	required: ["path", "content"],
	additionalProperties: false,
} as const;

function createWriteTool(env: SessionEnv): EngineTool {
	return {
		name: "write",
		description:
			"Write content to a file. Creates the file and parent directories if they do not exist.",
		parameters: WriteParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const path = requireString(args, "path");
			const content = requireString(args, "content");
			// SessionEnv.writeFile creates missing parent directories itself.
			await env.writeFile(path, content);
			return text(`Successfully wrote ${content.length} bytes to ${path}`, {
				path,
				size: content.length,
			});
		},
	};
}

// ─── edit ─────────────────────────────────────────────────────────────────────

const EditParams = {
	type: "object",
	properties: {
		path: { type: "string", description: "Path to the file to edit" },
		oldText: { type: "string", description: "Exact text to find (must be unique)" },
		newText: { type: "string", description: "Replacement text" },
		replaceAll: { type: "boolean", description: "Replace all occurrences" },
	},
	required: ["path", "oldText", "newText"],
	additionalProperties: false,
} as const;

function createEditTool(env: SessionEnv): EngineTool {
	return {
		name: "edit",
		description:
			"Edit a file using exact text replacement. The oldText must match a unique region of the file. Use replaceAll to replace all occurrences.",
		parameters: EditParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const path = requireString(args, "path");
			const oldText = requireString(args, "oldText");
			const newText = requireString(args, "newText");
			const replaceAll = optionalBoolean(args, "replaceAll");
			if (oldText === "") throw new Error("oldText must be a non-empty string.");

			const content = await env.readFile(path);

			if (replaceAll) {
				const newContent = content.replaceAll(oldText, newText);
				if (newContent === content) {
					throw new Error(`Could not find the text in ${path}. No changes made.`);
				}
				await env.writeFile(path, newContent);
				const count = content.split(oldText).length - 1;
				return text(`Replaced ${count} occurrences in ${path}`, { path, replacements: count });
			}

			const occurrences = countOccurrences(content, oldText);
			if (occurrences === 0) {
				throw new Error(
					`Could not find the exact text in ${path}. Make sure your oldText matches exactly, including whitespace and indentation.`,
				);
			}
			if (occurrences > 1) {
				throw new Error(
					`Found ${occurrences} occurrences of the text in ${path}. Provide more surrounding context to make the match unique, or use replaceAll.`,
				);
			}

			const newContent = content.replace(oldText, newText);
			await env.writeFile(path, newContent);
			return text(`Successfully edited ${path}`, { path });
		},
	};
}

// ─── bash ─────────────────────────────────────────────────────────────────────

const BashParams = {
	type: "object",
	properties: {
		command: { type: "string", description: "Bash command to execute" },
		timeout: { type: "number", description: "Timeout in seconds" },
	},
	required: ["command"],
	additionalProperties: false,
} as const;

function createBashTool(env: SessionEnv): EngineTool {
	return {
		name: "bash",
		description:
			"Execute a bash command. Returns stdout and stderr. Output is truncated to the last 2000 lines or 50KB.",
		parameters: BashParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const command = requireString(args, "command");
			const timeout = optionalNumber(args, "timeout");

			// Model-facing timeout stays in seconds (bash-tool convention); convert to ms. Default to a
			// ~30s floor (doc 08 §4.2) when the model supplies none, so the spawned child is actually
			// signal-killed at the deadline rather than merely abandoned by the dispatch-level race. A
			// timeout is surfaced as a recoverable 124-shaped result (the model can only emit JSON, so it
			// needs a recoverable shape); a host abort rethrows so the outer call cancels.
			const timeoutSec = typeof timeout === "number" ? timeout : DEFAULT_BASH_TIMEOUT_SEC;
			const timeoutMs = timeoutSec * 1000;
			const { timeoutSignal, mergedSignal: execSignal } = composeTimeoutSignal(timeoutMs, signal);

			const timedOut = () =>
				formatBashResult(
					{ stdout: "", stderr: `[cove] Command timed out after ${timeoutSec} seconds.`, exitCode: 124 },
					command,
				);
			try {
				const result = await env.exec(command, { timeoutMs, signal: execSignal });
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				return formatBashResult(result, command);
			} catch (err) {
				if (timeoutSignal?.aborted && !signal?.aborted) return timedOut();
				throw err;
			}
		},
	};
}

export function formatBashResult(
	result: { stdout: string; stderr: string; exitCode: number },
	command: string,
): EngineToolResult {
	return formatShellOutput(result, command);
}

// ─── grep ─────────────────────────────────────────────────────────────────────

const GrepParams = {
	type: "object",
	properties: {
		pattern: { type: "string", description: "Search pattern (regex)" },
		path: { type: "string", description: "Directory or file to search (default: .)" },
		include: { type: "string", description: 'Glob filter, e.g. "*.ts"' },
		literal: { type: "boolean", description: "Match the pattern as literal text" },
	},
	required: ["pattern"],
	additionalProperties: false,
} as const;

const grepBackends = new WeakMap<SessionEnv, Promise<"rg" | "grep">>();

function resolveGrepBackend(env: SessionEnv): Promise<"rg" | "grep"> {
	let backend = grepBackends.get(env);
	if (!backend) {
		// No caller signal: the probe is cached per-env, so an abort mid-probe must not poison the
		// cache. A short deadline keeps a hung exec from wedging the first search.
		backend = env
			.exec("rg --version", { timeoutMs: 10_000 })
			.then((result) => (result.exitCode === 0 ? "rg" : "grep"))
			.catch(() => "grep");
		grepBackends.set(env, backend);
	}
	return backend;
}

function createGrepTool(env: SessionEnv): EngineTool {
	return {
		name: "grep",
		description:
			"Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
		parameters: GrepParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const pattern = requireString(args, "pattern");
			const searchPath = optionalString(args, "path") || ".";
			const include = optionalString(args, "include");
			const literal = optionalBoolean(args, "literal");

			const backend = await resolveGrepBackend(env);
			let cmd: string;
			if (backend === "rg") {
				const literalFlag = literal ? " --fixed-strings" : "";
				const includeFlag = include ? ` --glob ${shellQuote(include)}` : "";
				cmd = `rg --line-number --with-filename --color never${literalFlag}${includeFlag} -- ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
			} else {
				const patternFlag = literal ? "-F" : "-E";
				const includeFlag = include ? ` --include=${shellQuote(include)}` : "";
				cmd = `grep -rnH ${patternFlag}${includeFlag} -- ${shellQuote(pattern)} ${shellQuote(searchPath)}`;
			}

			const result = await env.exec(cmd, { signal });
			if (result.exitCode === 1 && !result.stdout.trim()) {
				return text("No matches found.", { matchCount: 0 });
			}
			if (result.exitCode > 1) throw new Error(`grep failed: ${result.stderr}`);

			const lines = result.stdout.trim().split("\n");
			const truncatedLines = lines.slice(0, MAX_GREP_MATCHES);
			let output = truncatedLines
				.map((line) =>
					line.length > MAX_GREP_LINE_LENGTH ? `${line.slice(0, MAX_GREP_LINE_LENGTH)}...` : line,
				)
				.join("\n");
			if (lines.length > MAX_GREP_MATCHES) {
				output += `\n\n[Showing ${MAX_GREP_MATCHES} of ${lines.length} matches. Narrow your search.]`;
			}
			return text(output, { matchCount: Math.min(lines.length, MAX_GREP_MATCHES) });
		},
	};
}

// ─── glob ─────────────────────────────────────────────────────────────────────

const GlobParams = {
	type: "object",
	properties: {
		pattern: { type: "string", description: 'Filename pattern, e.g. "*.ts"' },
		path: { type: "string", description: "Directory to search in (default: .)" },
	},
	required: ["pattern"],
	additionalProperties: false,
} as const;

function createGlobTool(env: SessionEnv): EngineTool {
	return {
		name: "glob",
		description:
			"Find files by filename pattern using shell find -name semantics. Returns matching file paths.",
		parameters: GlobParams,
		async execute(args, signal) {
			throwIfAborted(signal);
			const pattern = requireString(args, "pattern");
			const searchPath = optionalString(args, "path") || ".";
			const cmd = `find ${shellQuote(searchPath)} -type f -name ${shellQuote(pattern)} 2>/dev/null | head -${MAX_GLOB_RESULTS}`;
			const result = await env.exec(cmd, { signal });

			const paths = result.stdout.trim().split("\n").filter(Boolean);
			if (paths.length === 0) {
				return text("No files found matching pattern.", { matchCount: 0 });
			}
			return text(paths.join("\n"), { matchCount: paths.length });
		},
	};
}

// ─── helpers ────────────────────────────────────────────────────────────────

function text(body: string, details?: unknown): EngineToolResult {
	return { content: [{ type: "text", text: body }], details };
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortErrorFor(signal);
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") {
		throw new Error(`[cove] tool argument "${key}" must be a string.`);
	}
	return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new Error(`[cove] tool argument "${key}" must be a string.`);
	return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number") throw new Error(`[cove] tool argument "${key}" must be a number.`);
	return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") throw new Error(`[cove] tool argument "${key}" must be a boolean.`);
	return value;
}

function formatReadContent(
	path: string,
	content: string,
	offset?: number,
	limit?: number,
): EngineToolResult {
	const allLines = content.split("\n");
	const startLine = offset ? Math.max(0, offset - 1) : 0;
	if (startLine >= allLines.length) {
		throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
	}
	const endLine = limit ? startLine + limit : allLines.length;
	const lines = allLines.slice(startLine, endLine);
	const { text: truncatedText, wasTruncated } = truncateHead(lines, MAX_READ_LINES, MAX_READ_BYTES);

	let output = truncatedText;
	if (wasTruncated) {
		const shownEnd = startLine + truncatedText.split("\n").length;
		output += `\n\n[Showing lines ${startLine + 1}-${shownEnd} of ${allLines.length}. Use offset=${shownEnd + 1} to continue.]`;
	}
	return text(output, { path, lines: allLines.length });
}

function countOccurrences(str: string, substr: string): number {
	let count = 0;
	let pos = str.indexOf(substr, 0);
	while (pos !== -1) {
		count++;
		pos = str.indexOf(substr, pos + Math.max(substr.length, 1));
	}
	return count;
}

function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function truncateHead(
	lines: string[],
	maxLines: number,
	maxBytes: number,
): { text: string; wasTruncated: boolean } {
	let result = "";
	let lineCount = 0;
	let wasTruncated = false;
	for (const line of lines) {
		if (lineCount >= maxLines) {
			wasTruncated = true;
			break;
		}
		const next = lineCount === 0 ? line : `\n${line}`;
		if (result.length + next.length > maxBytes) {
			wasTruncated = true;
			break;
		}
		result += next;
		lineCount++;
	}
	return { text: result, wasTruncated };
}

