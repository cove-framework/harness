// Ported from flue · @flue/cli · packages/cli/src/lib/build.ts → @cove/cli.
// New (Convex backend). KEPT only the content-compare/`changed`-tracking idea (build.ts:215–232). DROPPED:
// discoverAgents/discoverModules (the registry map is the source of truth, not an `agents/` scan),
// resolvePlugin, and ALL Vite (viteBuild/createSharedViteConfig/getUserExternals/etc.).
//
// `cove build` orchestrates: resolveConfig → load+validate registries (in the isolated tsx child) → codegen
// (agent/workflow resolvers + http.ts patch, content-compared so a no-op rebuild writes 0 files) → optional
// m3 skill packaging → `tsc --noEmit` gate → `[cove]` success banner. Returns `{ changed }`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as path from "node:path";
import { generateAgentResolver } from "../codegen/generate-agent-registry.ts";
import { generateExtensionResolver } from "../codegen/generate-extension-registry.ts";
import { generateHttpEntry } from "../codegen/generate-http-entry.ts";
import { generateToolResolver } from "../codegen/generate-tool-registry.ts";
import { generateWorkflowResolver } from "../codegen/generate-workflow-registry.ts";
import {
	loadAgentRegistry,
	loadWorkflowRegistry,
} from "../codegen/registry-loader.ts";
import { type CoveConfig, resolveConfig } from "../lib/config.ts";
import { brandRows, section, success } from "../lib/terminal.ts";
import { packageSkills } from "../packaging/package-skills.ts";

export interface BuildOptions {
	/** Explicit --root, or undefined for cwd. */
	explicitRoot?: string;
	/** Explicit --config path, or undefined to auto-discover. */
	configFile?: string;
	/** Suppress the banner / per-file success lines (used by dev's quiet rebuilds). */
	log?: "verbose" | "silent";
	/** Skip the `tsc --noEmit` gate (dev uses this — `convex dev` typechecks). */
	skipTypecheck?: boolean;
}

export interface BuildResult {
	changed: boolean;
	cfg: CoveConfig;
	configPath?: string;
}

/** Run load→validate→codegen (+ optional m3) and return whether any file changed. */
export async function build(options: BuildOptions = {}): Promise<BuildResult> {
	const { coveConfig: cfg, configPath } = await resolveConfig({
		cwd: process.cwd(),
		searchFrom: options.explicitRoot ?? process.cwd(),
		configFile: options.configFile,
		inline: options.explicitRoot ? { root: options.explicitRoot } : undefined,
	});
	const verbose = options.log !== "silent";
	const rel = (p: string) => relativeTo(cfg.root, p);

	// Load + validate registries (runs inside the isolated tsx child).
	const agentReg = await loadAgentRegistry(cfg);
	const workflowReg = await loadWorkflowRegistry(cfg);

	if (verbose) {
		brandRows("cove build", [
			["root", rel(cfg.root)],
			["convex", rel(cfg.convexDir)],
			["config", configPath ? rel(configPath) : undefined],
			["skills", cfg.skills.length > 0 ? cfg.skills.map(rel).join(", ") : undefined],
		]);
		section("agents", agentReg.names);
		section("workflows", workflowReg.names);
		console.error("");
	}

	let anyChanged = false;
	const note = (label: string, p: string, changed: boolean) => {
		if (verbose && changed) success(`${label} ${rel(p)}`);
	};

	const agentResolver = generateAgentResolver({ convexDir: cfg.convexDir, exportName: agentReg.exportName });
	anyChanged ||= agentResolver.changed;
	note("generated", agentResolver.path, agentResolver.changed);

	const workflowResolver = generateWorkflowResolver({
		convexDir: cfg.convexDir,
		exportName: workflowReg.exportName,
	});
	anyChanged ||= workflowResolver.changed;
	note("generated", workflowResolver.path, workflowResolver.changed);

	// Tool registry resolver (pragmatic-refactor Phase 3): by convention the registry is the `tools` export
	// of convex/toolRegistry.ts. Always emitted so setup.ts/dispatchTools.ts can side-effect-import it.
	const toolResolver = generateToolResolver({ convexDir: cfg.convexDir, exportName: "tools" });
	anyChanged ||= toolResolver.changed;
	note("generated", toolResolver.path, toolResolver.changed);

	// Extension registry resolver (pragmatic-refactor Phase 5): by convention the registry is the
	// `extensions` export of convex/extensionRegistry.ts. Always emitted so setup.ts can side-effect-import it.
	const extensionResolver = generateExtensionResolver({ convexDir: cfg.convexDir, exportName: "extensions" });
	anyChanged ||= extensionResolver.changed;
	note("generated", extensionResolver.path, extensionResolver.changed);

	const httpEntry = generateHttpEntry({ convexDir: cfg.convexDir });
	anyChanged ||= httpEntry.changed;
	note(httpEntry.mode === "patched" ? "patched" : "validated", httpEntry.path, httpEntry.changed);

	// m3 skill packaging — OPT-IN (only when config.skills is set).
	if (cfg.skills.length > 0) {
		const packaged = await packageSkills({ root: cfg.root, skillSources: cfg.skills });
		anyChanged ||= packaged.changed;
		note("packaged", packaged.path, packaged.changed);
	}

	// tsc --noEmit gate (the emitted convex/_cove/*.ts + patched http.ts must type-check).
	if (!options.skipTypecheck) {
		await runTypecheck(cfg.root);
		if (verbose) success("typecheck passed");
	}

	if (verbose) success(`ready ${rel(cfg.convexDir)}`);
	return { changed: anyChanged, cfg, configPath };
}

function relativeTo(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}

/** Resolve the TypeScript `tsc` entry (from the user project, else this CLI's deps) for a robust spawn. */
function resolveTscBin(root: string): string | undefined {
	for (const base of [path.join(root, "package.json"), import.meta.url]) {
		try {
			return createRequire(base).resolve("typescript/bin/tsc");
		} catch {
			// try the next resolution base
		}
	}
	return undefined;
}

/**
 * Spawn `tsc --noEmit`; reject (fail-closed for deploy) on non-zero exit. Invokes `node <tsc>` against the
 * resolved TypeScript entry so it works regardless of whether `node_modules/.bin` is executable / on PATH;
 * falls back to `npx tsc`.
 */
function runTypecheck(root: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const tscBin = resolveTscBin(root);
		const child = tscBin
			? spawn(process.execPath, [tscBin, "--noEmit"], { cwd: root, stdio: "inherit" })
			: spawn("npx", ["tsc", "--noEmit"], { cwd: root, stdio: "inherit" });
		child.once("error", (err) => reject(new Error(`[cove] tsc failed to start: ${err.message}`)));
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`[cove] tsc --noEmit failed (exit ${code ?? "unknown"}).`));
		});
	});
}
