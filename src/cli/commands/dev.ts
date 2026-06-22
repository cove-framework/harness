// Ported from flue · @flue/cli · packages/cli/src/lib/dev.ts → @cove/cli.
// New (Convex backend). REPLACED the Vite/Node reloaders with `spawn('npx', ['convex','dev'], {stdio:'inherit'})`
// — `convex dev` owns function hot-reload. KEPT: createWatcher's debounced (150ms, dev.ts:250–303) re-codegen
// over `cove.config.*` + the two registry files (the only inputs to codegen), and the SIGINT/SIGTERM shutdown
// forwarding (dev.ts:194–222) so Ctrl+C tears down the convex child. The rebuild action is RE-CODEGEN ONLY.

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { build } from "./build.ts";
import {
	agentRegistryPath,
	workflowRegistryPath,
} from "../codegen/registry-loader.ts";
import { resolveConfig, resolveConfigCandidates } from "../lib/config.ts";
import { dim, error, note, success } from "../lib/terminal.ts";

const DEBOUNCE_MS = 150;

export interface DevOptions {
	explicitRoot?: string;
	configFile?: string;
}

/** Run codegen+validate once, start `convex dev`, watch + re-codegen on change. Blocks until a signal. */
export async function dev(options: DevOptions = {}): Promise<void> {
	// Initial codegen + validation. `convex dev` does its own typecheck on start,
	// so we skip the tsc gate here for a faster boot — validation still runs.
	const { cfg } = await build({
		explicitRoot: options.explicitRoot,
		configFile: options.configFile,
		log: "verbose",
		skipTypecheck: true,
	});

	// Start `convex dev` (inherits stdio so its output flows to the user).
	let child: ChildProcess | undefined = spawn("npx", ["convex", "dev"], {
		cwd: cfg.root,
		stdio: "inherit",
	});

	let shuttingDown = false;
	const shutdown = (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`\n${dim(signal)} shutting down`);
		watcher.close();
		if (child && !child.killed) child.kill(signal);
		else process.exit(signal === "SIGINT" ? 130 : 143);
	};

	child.once("exit", (code, signal) => {
		if (shuttingDown) {
			process.exit(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 0));
		}
		// convex dev exited on its own — surface its code and stop watching.
		watcher.close();
		process.exit(code ?? 1);
	});

	// Re-codegen on config / registry change (debounced). convex dev owns reload.
	const rebuild = createRebuilder(async () => {
		try {
			await build({
				explicitRoot: options.explicitRoot,
				configFile: options.configFile,
				log: "silent",
				skipTypecheck: true,
			});
			success("re-generated cove wiring");
		} catch (err) {
			// Don't tear down dev on a codegen error — the user will fix + retrigger.
			error(`Codegen failed: ${err instanceof Error ? err.message : String(err)}`);
			note("fix the error; dev is still watching");
		}
	});

	const watched = new Set<string>([
		...resolveConfigCandidates({
			cwd: process.cwd(),
			searchFrom: options.explicitRoot ?? process.cwd(),
			configFile: options.configFile,
		}),
		agentRegistryPath(cfg),
		workflowRegistryPath(cfg),
	]);

	const watcher = createWatcher([...watched], (file) => {
		console.error(`${dim("changed")} ${relativeTo(cfg.root, file)}`);
		rebuild.schedule();
	});

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	// Last-resort: hard-kill the child if the parent exits unexpectedly.
	process.on("exit", () => {
		try {
			if (child && !child.killed) child.kill("SIGKILL");
		} catch {
			/* ignore */
		}
		child = undefined;
	});

	// Block forever until a signal exits the process.
	await new Promise<void>(() => {});
}

interface Rebuilder {
	schedule(): void;
}

/** Debounce + coalesce re-codegen runs (flue dev.ts:250–303, minus the reloader force flag). */
function createRebuilder(rebuild: () => Promise<void>): Rebuilder {
	let running = false;
	let queued = false;
	let timer: NodeJS.Timeout | null = null;

	const runOnce = async () => {
		running = true;
		try {
			await rebuild();
		} finally {
			running = false;
			if (queued) {
				queued = false;
				void runOnce();
			}
		}
	};

	return {
		schedule() {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				if (running) queued = true;
				else void runOnce();
			}, DEBOUNCE_MS);
		},
	};
}

interface WatcherHandle {
	close(): void;
}

/**
 * Watch a fixed set of files (config + the two registry files) for changes.
 * Watches each file's parent directory + filters by basename (fs.watch on a file
 * is unreliable across editors that rename-on-save). The ignore-list idea from
 * flue's createWatcher is reduced to "only these files matter".
 */
function createWatcher(files: string[], onChange: (file: string) => void): WatcherHandle {
	const watchers: fs.FSWatcher[] = [];
	const byDir = new Map<string, Set<string>>();
	for (const file of files) {
		const dir = path.dirname(file);
		const set = byDir.get(dir) ?? new Set<string>();
		set.add(path.basename(file));
		byDir.set(dir, set);
	}
	for (const [dir, basenames] of byDir) {
		try {
			const w = fs.watch(dir, (_event, filename) => {
				const base = filename?.toString();
				if (base && basenames.has(base)) onChange(path.join(dir, base));
			});
			watchers.push(w);
		} catch {
			/* the dir may not exist yet — ignore */
		}
	}
	return {
		close() {
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

function relativeTo(root: string, filePath: string): string {
	const relative = path.relative(root, filePath);
	return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : filePath;
}
