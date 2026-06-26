// New (Convex backend) · @cove/runtime · phase-03 execution-boundary guard (08 §3 / acceptance #9).
// The V8-safe core (src/runtime/*) must NEVER import the AI SDK — ModelHandle.model is `unknown`
// there, cast back to LanguageModelV3 only inside convex/providers. The provider files that import
// the AI SDK at runtime (gateway.ts, the barrel) carry "use node".

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
// Tests live in __tests__/; the source dir under test is the parent (convex/providers).
const SRC = join(HERE, "..");
const RUNTIME = join(SRC, "..", "..", "src", "runtime");

/** Strip block + line comments so doc-comment mentions of "ai"/@ai-sdk don't false-positive. */
function stripComments(src: string): string {
	return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("provider execution boundary (08 §3)", () => {
	it("src/runtime/* imports no AI SDK (`ai` / @ai-sdk/* ) and no @upstash/box", () => {
		const files = readdirSync(RUNTIME).filter((f) => f.endsWith(".ts"));
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const code = stripComments(readFileSync(join(RUNTIME, f), "utf8"));
			expect(code, `${f} must not import "ai"`).not.toMatch(/from\s+["']ai["']/);
			expect(code, `${f} must not import @ai-sdk/*`).not.toMatch(/from\s+["']@ai-sdk\//);
			expect(code, `${f} must not import @upstash/box`).not.toMatch(/from\s+["']@upstash\//);
		}
	});

	it('AI-SDK-importing provider files carry "use node"', () => {
		for (const f of ["gateway.ts", "index.ts"]) {
			const first = readFileSync(join(SRC, f), "utf8")
				.split("\n")
				.find((l) => l.trim() !== "")
				?.trim();
			expect(first, `${f}`).toBe('"use node";');
		}
	});
});
