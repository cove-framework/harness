// New — the publishable build (model A, "downloadable package"). `tsc` alone can't emit while
// `allowImportingTsExtensions` is on and the source imports with explicit `.ts` specifiers, so tsup (esbuild)
// rewrites `.ts`→`.js` and emits `.d.ts`. Builds the four client/authoring surfaces + the CLI bin into dist/.
// Deps + peerDeps are auto-externalized by tsup; node builtins are always external. The Convex backend
// (convex/**) is NOT built here — it ships as source and is scaffolded into a user project by `cove init`
// (model C). See README "Install".
import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
	version: string;
};

export default defineConfig({
	entry: {
		"runtime/index": "src/runtime/index.ts",
		"sdk/index": "src/sdk/index.ts",
		"react/index": "src/react/index.ts",
		"cli/index": "src/cli/index.ts",
		// The CLI binary, bundled. The bin/cove.mjs launcher shim (plain JS, runs the Node-version gate on the
		// user's Node) spawns `node dist/bin/cove.js`.
		"bin/cove": "bin/cove.ts",
	},
	outDir: "dist",
	format: ["esm"],
	target: "node22",
	dts: true,
	// ESM code-splitting → the shared src/runtime modules pulled in by both the runtime entry and sdk/react
	// become shared chunks instead of being duplicated per entry.
	splitting: true,
	sourcemap: true,
	clean: true,
	// `cove --version` reads this at runtime; injected so the compiled bin needn't fs-read package.json from a
	// path that moves under dist/.
	define: { __COVE_VERSION__: JSON.stringify(pkg.version) },
});
