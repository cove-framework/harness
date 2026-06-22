// New (Convex backend) · @cove/cli — `cove deploy`.
// Structural sibling of flue's deploy path, re-targeted at `convex deploy`. FAIL-CLOSED (spec §Risks +
// Acceptance): run build()'s load→validate→codegen→tsc FIRST; if ANY step fails, exit non-zero and NEVER
// spawn `convex deploy` — a half-deployed app with an invalid registry is the failure mode. On success,
// spawn `npx convex deploy` and surface its exit code.

import { spawn } from "node:child_process";
import { build } from "./build.ts";
import { error, success } from "../lib/terminal.ts";

export interface DeployOptions {
	explicitRoot?: string;
	configFile?: string;
}

/** Fail-closed deploy. Returns the process exit code to use. */
export async function deploy(options: DeployOptions = {}): Promise<number> {
	let root: string;
	try {
		// build() runs resolveConfig → load+validate registries → codegen → tsc.
		// Any throw here means we MUST NOT spawn convex deploy.
		const result = await build({
			explicitRoot: options.explicitRoot,
			configFile: options.configFile,
			log: "verbose",
			skipTypecheck: false,
		});
		root = result.cfg.root;
	} catch (err) {
		error(err instanceof Error ? err.message : String(err));
		// Fail-closed: convex deploy is NEVER spawned.
		return 1;
	}

	success("validation + codegen passed; deploying via convex");
	return spawnConvexDeploy(root);
}

/** Spawn `npx convex deploy`, inheriting stdio, returning its exit code. */
function spawnConvexDeploy(cwd: string): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn("npx", ["convex", "deploy"], { cwd, stdio: "inherit" });
		child.once("error", (err) => {
			error(`failed to spawn convex deploy: ${err.message}`);
			resolve(1);
		});
		child.once("exit", (code, signal) => {
			if (signal) resolve(signal === "SIGINT" ? 130 : 143);
			else resolve(code ?? 1);
		});
	});
}
