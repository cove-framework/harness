// New (Convex backend) · @cove/runtime · phase-02 execution-boundary guard (08 §3).
// Self-guards the invariant the acceptance bar requires: the pure scaffolding
// (sessionEnv.ts / abort.ts) is V8-safe — no "use node", no @upstash/box / node-fs /
// child_process / convex import — so it stays importable from anywhere; and the two
// adapters carry "use node" as their first statement so Convex permits their imports.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
// Tests live in __tests__/; the source dir under test is the parent (convex/sandbox).
const SRC = join(HERE, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");
const firstStatement = (src: string) => src.split("\n").find((l) => l.trim() !== "")?.trim();
/** Strip block + line comments so a doc-comment mentioning "use node" doesn't false-positive. */
const stripComments = (src: string) =>
	src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("sandbox execution boundary (08 §3)", () => {
	const PURE = ["sessionEnv.ts", "abort.ts"];
	const NODE = ["upstashBox.ts", "localBash.ts"];

	for (const f of PURE) {
		it(`${f} is V8-safe: no "use node", no box/fs/child_process/convex import`, () => {
			const code = stripComments(read(f));
			// No use-node DIRECTIVE (a bare string-literal statement) — comments are fine.
			expect(code, "must not declare a use node directive").not.toMatch(
				/^\s*["']use node["']\s*;?\s*$/m,
			);
			expect(code, "must not import @upstash/box").not.toMatch(/from\s+["']@upstash\/box["']/);
			expect(code, "must not import node fs/child_process").not.toMatch(
				/from\s+["'](node:)?(child_process|fs|fs\/promises)["']/,
			);
			expect(code, "must not import convex").not.toMatch(/from\s+["']convex(\/|["'])/);
		});
	}

	for (const f of NODE) {
		it(`${f} carries "use node" as its first statement`, () => {
			expect(firstStatement(read(f))).toBe('"use node";');
		});
	}
});
