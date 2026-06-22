// New (Convex backend) · @cove/runtime — G2.6 multi-project vitest config.
// The existing pure-logic units run on the `node` env (they import "use node" modules transitively + use DI
// ports with node globals); the new `tests/` tree runs on the `edge-runtime` env, where convex-test's
// convexTest(schema) executes Convex functions inside an in-memory deployment. One shared env fails — split.
// (src/react tests keep their per-file `// @vitest-environment happy-dom` pragma; it overrides the project env.)
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "units",
					environment: "node",
					include: [
						"convex/**/__tests__/**/*.test.{ts,tsx}",
						"src/**/__tests__/**/*.test.{ts,tsx}",
						"examples/**/__tests__/**/*.test.{ts,tsx}",
					],
				},
			},
			{
				test: {
					name: "integration",
					environment: "edge-runtime",
					include: ["tests/**/*.test.ts"],
					server: { deps: { inline: ["convex-test"] } },
				},
			},
		],
	},
});
