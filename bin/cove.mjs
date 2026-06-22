#!/usr/bin/env node
// @ts-nocheck
// Launcher shim parity with flue · @flue/cli · packages/cli/bin/flue.mjs → @cove/cli (bin/cove.mjs).
// New (Convex backend). Referenced from package.json "bin". Runs on the user's Node so it uses only
// universally-available JS and is NOT compiled — it runs the Node-version gate, then spawns the COMPILED CLI
// (`node dist/bin/cove.js`, emitted by tsup) and forwards argv + the exit code. When running from a source
// checkout where dist/ hasn't been built, it falls back to `tsx bin/cove.ts`.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;
const ENGINES_LABEL = ">=22.18 or >=23.6";

function checkNodeVersion() {
	const v = process.versions.node;
	const m = /^(\d+)\.(\d+)/.exec(v);
	if (!m) return; // unparseable; let it through and let the real CLI fail loudly
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	// Node 23.0–23.5 lacks default TS type-stripping; unsupported despite the floor.
	if (major !== 23 || minor >= 6) {
		if (major > MIN_NODE_MAJOR) return;
		if (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR) return;
	}
	console.error(
		"\nNode.js v" +
			v +
			" is not supported by Cove.\n" +
			"Cove requires Node.js " +
			ENGINES_LABEL +
			" for native TypeScript support.\n" +
			"Please upgrade: https://nodejs.org/\n",
	);
	process.exit(1);
}

checkNodeVersion();

const here = path.dirname(fileURLToPath(import.meta.url));
const compiled = path.join(here, "..", "dist", "bin", "cove.js");
const args = process.argv.slice(2);

// Published install: run the compiled CLI directly on the user's Node (no tsx required).
let child;
if (fs.existsSync(compiled)) {
	child = spawn(process.execPath, [compiled, ...args], { stdio: "inherit" });
} else {
	// Source checkout (dist/ not built): fall back to executing the TS entry via tsx.
	const entry = path.join(here, "cove.ts");
	let tsxCli;
	try {
		tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
	} catch {
		tsxCli = undefined;
	}
	child = tsxCli
		? spawn(process.execPath, [tsxCli, entry, ...args], { stdio: "inherit" })
		: spawn("tsx", [entry, ...args], { stdio: "inherit" });
}

child.on("error", (err) => {
	console.error(err);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.exit(signal === "SIGINT" ? 130 : 143);
	process.exit(code ?? 0);
});
