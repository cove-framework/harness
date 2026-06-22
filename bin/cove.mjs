#!/usr/bin/env node
// @ts-nocheck
// Launcher shim parity with flue · @flue/cli · packages/cli/bin/flue.mjs → @cove/cli (bin/cove.mjs).
// New (Convex backend). Referenced from package.json "bin". Runs on the user's Node — including older
// versions — so it uses only universally-available JS and is NOT compiled. Unlike flue (which handed off to a
// compiled dist), cove ships its CLI as TS and executes it via `tsx` (package.json:34). This shim spawns
// `tsx bin/cove.ts` and forwards argv + the exit code.

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
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
const entry = path.join(here, "cove.ts");

// Resolve the `tsx` CLI from this package's install. Fall back to the PATH `tsx`.
let tsxCli;
try {
	const require = createRequire(import.meta.url);
	tsxCli = require.resolve("tsx/cli");
} catch {
	tsxCli = undefined;
}

const child = tsxCli
	? spawn(process.execPath, [tsxCli, entry, ...process.argv.slice(2)], { stdio: "inherit" })
	: spawn("tsx", [entry, ...process.argv.slice(2)], { stdio: "inherit" });

child.on("error", (err) => {
	console.error(err);
	process.exit(1);
});
child.on("exit", (code, signal) => {
	if (signal) process.exit(signal === "SIGINT" ? 130 : 143);
	process.exit(code ?? 0);
});
