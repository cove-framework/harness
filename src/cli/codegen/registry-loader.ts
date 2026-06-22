// New (Convex backend) · @cove/cli — registry loader (no flue analogue; flue scanned the `agents/` filesystem).
//
// Loads the app-bound `convex/agentRegistry.ts` / `convex/workflowRegistry.ts` so the declared maps can be
// read for validation + emission. RISK (spec §Risks): importing the app-bound module *in the CLI process*
// risks dragging in Convex module globals (the registry transitively imports runtime types, and a real app's
// registry may import other convex/ modules that reference Convex globals). MITIGATION: isolate the import in
// a short-lived `tsx` child that imports the registry files, RUNS validation there (validate-registry.ts,
// where the live AgentRegistry/WorkflowRegistry objects exist — the createAgent initializer can't be JSON'd),
// and reports back over stdout: the declared names on success, or a single `[cove]` diagnostic on failure.
//
// Wrap ANY import/validation failure as ONE `[cove] failed to load <file>: <message>` line (never a stack) —
// a user typo must be a one-line error.
//
// IMPLEMENTATION NOTE (for integration): the child is a tiny importer script written to an OS temp file and
// run via `tsx`. Against a REAL user project the child must resolve the project's `tsx` + run with the
// project root as cwd so the registry's relative imports resolve; if a user app's registry pulls in Convex
// globals that even *import* fails on, the child may need a `--conditions`/`--import` shim — flagged here for
// central integration. The byte-stable codegen itself only needs `names` (declared order), so the success
// payload is intentionally minimal.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { CoveConfig } from "../lib/config.ts";

export interface LoadedAgentRegistry {
	/** Declared agent names in object-key (declared) order. */
	readonly names: string[];
	/** Export name the registry was found under (default "registry"). */
	readonly exportName: string;
}

export interface LoadedWorkflowRegistry {
	readonly names: string[];
	readonly exportName: string;
}

const AGENT_REGISTRY_BASENAME = "agentRegistry.ts";
const WORKFLOW_REGISTRY_BASENAME = "workflowRegistry.ts";

/** Path to the user's agent registry source. */
export function agentRegistryPath(cfg: CoveConfig): string {
	return path.join(cfg.convexDir, AGENT_REGISTRY_BASENAME);
}

/** Path to the user's workflow registry source. */
export function workflowRegistryPath(cfg: CoveConfig): string {
	return path.join(cfg.convexDir, WORKFLOW_REGISTRY_BASENAME);
}

/**
 * Load + validate the agent registry in an isolated tsx child. Returns the
 * declared names. Throws a single-line `[cove]` Error on any import/validation
 * failure.
 */
export async function loadAgentRegistry(cfg: CoveConfig): Promise<LoadedAgentRegistry> {
	const file = agentRegistryPath(cfg);
	assertExists(file, "agent registry");
	const result = await runChild(cfg, "agent", file);
	return { names: result.names, exportName: result.exportName };
}

/** Load + validate the workflow registry in an isolated tsx child. */
export async function loadWorkflowRegistry(cfg: CoveConfig): Promise<LoadedWorkflowRegistry> {
	const file = workflowRegistryPath(cfg);
	assertExists(file, "workflow registry");
	const result = await runChild(cfg, "workflow", file);
	return { names: result.names, exportName: result.exportName };
}

function assertExists(file: string, label: string): void {
	if (!fs.existsSync(file)) {
		throw new Error(`[cove] failed to load ${file}: ${label} file not found.`);
	}
}

interface ChildResult {
	names: string[];
	exportName: string;
}

/**
 * Spawn `tsx <importer>` with the registry file path + kind as argv. The importer
 * imports the registry, runs validation, and prints one JSON line on stdout:
 *   { ok: true, names, exportName }  — success
 *   { ok: false, message }           — a single [cove] diagnostic
 * Any uncaught throw / non-zero exit / unparseable output → one [cove] line.
 */
function runChild(cfg: CoveConfig, kind: "agent" | "workflow", file: string): Promise<ChildResult> {
	return new Promise((resolve, reject) => {
		let importerPath: string;
		try {
			importerPath = writeImporterScript();
		} catch (err) {
			reject(new Error(`[cove] failed to load ${file}: ${errText(err)}`));
			return;
		}

		const child = spawn(
			process.execPath,
			[tsxBinaryPath(), importerPath, kind, file],
			{
				cwd: cfg.root,
				// Pipe stdout (the JSON result); inherit stderr so a genuine crash is visible.
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env },
			},
		);

		let out = "";
		let err = "";
		child.stdout?.on("data", (d: Buffer) => {
			out += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			err += d.toString();
		});
		const cleanup = () => {
			try {
				fs.unlinkSync(importerPath);
			} catch {
				/* ignore */
			}
		};
		child.once("error", (spawnErr) => {
			cleanup();
			reject(new Error(`[cove] failed to load ${file}: ${errText(spawnErr)}`));
		});
		child.once("exit", (code) => {
			cleanup();
			// The importer prints exactly one JSON line on its last line of stdout.
			const line = out.trim().split("\n").filter(Boolean).pop();
			if (line) {
				try {
					const parsed = JSON.parse(line) as
						| { ok: true; names: string[]; exportName: string }
						| { ok: false; message: string };
					if (parsed.ok) {
						resolve({ names: parsed.names, exportName: parsed.exportName });
						return;
					}
					reject(new Error(oneLine(parsed.message)));
					return;
				} catch {
					/* fall through to generic */
				}
			}
			const detail = oneLine(err) || `child exited with code ${code ?? "unknown"}`;
			reject(new Error(`[cove] failed to load ${file}: ${detail}`));
		});
	});
}

/** Collapse a (possibly multi-line) message to one [cove] line. */
function oneLine(message: string): string {
	const first = message.split("\n").map((s) => s.trim()).filter(Boolean)[0] ?? message.trim();
	return first.startsWith("[cove]") ? first : `[cove] ${first}`;
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Resolve the project-local `tsx` CLI entry. */
function tsxBinaryPath(): string {
	// tsx ships a CLI at dist/cli.mjs; resolve from this module's node_modules chain.
	// `import.meta.resolve` would be cleaner but isn't reliably available under all
	// loaders, so walk node_modules — matching how the build tools resolve deps.
	let dir = path.dirname(new URL(import.meta.url).pathname);
	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, "node_modules", "tsx", "dist", "cli.mjs");
		if (fs.existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	// Fall back to the npx-installed `tsx` on PATH (spawn resolves it).
	return "tsx";
}

/**
 * The importer script body. It is intentionally tiny + self-contained: import the
 * registry file via a file URL, find the registry export, validate, print JSON.
 * Validation logic lives in validate-registry.ts (imported here so it runs in the
 * child, where the live objects exist).
 */
function writeImporterScript(): string {
	const validatorUrl = pathToFileURL(
		path.join(path.dirname(new URL(import.meta.url).pathname), "..", "validation", "validate-registry.ts"),
	).href;
	const body = `
// Auto-generated by cove (do not edit) — transient registry importer.
import { pathToFileURL } from "node:url";
import { validateAgentRegistry, validateWorkflowRegistry } from ${JSON.stringify(validatorUrl)};

const [, , kind, file] = process.argv;

function emit(payload) {
	process.stdout.write(JSON.stringify(payload) + "\\n");
}

function oneLine(message) {
	const first = String(message).split("\\n").map((s) => s.trim()).filter(Boolean)[0] || String(message);
	return first.startsWith("[cove]") ? first : "[cove] " + first;
}

async function main() {
	let mod;
	try {
		mod = await import(pathToFileURL(file).href);
	} catch (err) {
		emit({ ok: false, message: "[cove] failed to load " + file + ": " + oneLine(err && err.message ? err.message : err) });
		process.exit(1);
		return;
	}
	if (kind === "agent") {
		const found = pickRegistry(mod, ["registry", "agents", "default"], (v) => v && typeof v.get === "function" && Array.isArray(v.names) && typeof v.has === "function");
		if (!found) {
			emit({ ok: false, message: "[cove] " + file + " must export an AgentRegistry (e.g. \`export const registry = defineAgentRegistry({...})\`)." });
			process.exit(1);
			return;
		}
		try {
			await validateAgentRegistry(found.value);
		} catch (err) {
			emit({ ok: false, message: oneLine(err && err.message ? err.message : err) });
			process.exit(1);
			return;
		}
		emit({ ok: true, names: [...found.value.names], exportName: found.name });
		return;
	}
	const found = pickRegistry(mod, ["workflows", "registry", "default"], (v) => v && typeof v.get === "function" && Array.isArray(v.names) && typeof v.has === "function");
	if (!found) {
		emit({ ok: false, message: "[cove] " + file + " must export a WorkflowRegistry (e.g. \`export const workflows = defineWorkflowRegistry({...})\`)." });
		process.exit(1);
		return;
	}
	try {
		validateWorkflowRegistry(found.value);
	} catch (err) {
		emit({ ok: false, message: oneLine(err && err.message ? err.message : err) });
		process.exit(1);
		return;
	}
	emit({ ok: true, names: [...found.value.names], exportName: found.name });
}

function pickRegistry(mod, preferredNames, isRegistry) {
	for (const name of preferredNames) {
		if (name in mod && isRegistry(mod[name])) return { name, value: mod[name] };
	}
	for (const name of Object.keys(mod)) {
		if (isRegistry(mod[name])) return { name, value: mod[name] };
	}
	return undefined;
}

main().catch((err) => {
	emit({ ok: false, message: oneLine(err && err.message ? err.message : err) });
	process.exit(1);
});
`;
	const tmp = path.join(os.tmpdir(), `cove-registry-importer-${process.pid}-${Date.now()}.mjs`);
	fs.writeFileSync(tmp, body, "utf-8");
	return tmp;
}
