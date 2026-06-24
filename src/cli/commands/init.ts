// New (Convex backend) · @cove/cli — `cove init`: scaffold a new Cove project (model C, "starter template").
//
// The Convex backend cannot be an ordinary npm import — Convex deploys functions from the *consumer's own*
// convex/ dir. So `cove init` VENDORS the backend the user owns: it copies this package's own `convex/` +
// `src/runtime/` into the target, then writes the starter scaffolding (config, an example agent registry, env
// template, tsconfig, README, package.json). The published client surfaces (@cove-framework/cove/runtime,
// /sdk, /react) + the `cove` CLI come from the npm package the scaffold depends on. See README "Install".
//
// The vendored backend's relative imports (`../src/runtime/...` from convex/**) are preserved by copying
// convex/ + src/runtime/ with their layout intact. The demo `_cove/*` resolvers are NOT copied — they are
// regenerated from the scaffolded registry via the same pure codegen `cove build`/`dev` use, so the fresh
// project type-checks out of the box AND matches what the next `cove build` would emit.

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { renderAgentResolver } from "../codegen/generate-agent-registry.ts";
import { renderExtensionResolver } from "../codegen/generate-extension-registry.ts";
import { renderToolResolver } from "../codegen/generate-tool-registry.ts";
import { renderWorkflowResolver } from "../codegen/generate-workflow-registry.ts";
import { blue, dim, note, success } from "../lib/terminal.ts";

export interface InitOptions {
	/** Target directory (relative to cwd) or undefined for the cwd. */
	dir?: string;
	/** Overwrite / scaffold into a non-empty directory. */
	force?: boolean;
}

/** Package-relative source trees vendored into the new project (model C). */
const VENDOR_DIRS = ["convex", path.join("src", "runtime")] as const;

/** Scaffold a new Cove project. Throws a single-line `[cove]` Error on failure. */
export async function initProject(options: InitOptions = {}): Promise<void> {
	const pkgRoot = findPackageRoot();
	const targetDir = path.resolve(process.cwd(), options.dir ?? ".");
	const projectName = sanitizePackageName(path.basename(targetDir));

	ensureTargetWritable(targetDir, options.force === true);

	// 1. Vendor the backend the user owns: convex/ (engine + authoring surface) + src/runtime/ (V8-safe core).
	for (const rel of VENDOR_DIRS) {
		copyTreeFiltered(path.join(pkgRoot, rel), path.join(targetDir, rel));
	}

	// 2. Append the starter registries the codegen + the http routes resolve against.
	appendStarterRegistries(targetDir);

	// 3. Regenerate the _cove/* resolvers from the scaffolded registry (pure codegen — matches `cove build`).
	writeFile(path.join(targetDir, "convex", "_cove", "agentResolver.ts"), renderAgentResolver("registry"));
	writeFile(path.join(targetDir, "convex", "_cove", "workflowResolver.ts"), renderWorkflowResolver("workflows"));
	writeFile(path.join(targetDir, "convex", "_cove", "toolResolver.ts"), renderToolResolver("tools"));
	writeFile(path.join(targetDir, "convex", "_cove", "extensionResolver.ts"), renderExtensionResolver("extensions"));

	// 4. Project scaffolding (config, env, tsconfig, gitignore, README, package.json).
	writeScaffolding(targetDir, projectName, pkgRoot);

	printNextSteps(targetDir, options.dir);
}

// ─── Package root discovery ──────────────────────────────────────────────────

/** Walk up from this module to the installed `cove` package root (works from src/ in dev and dist/ when built). */
function findPackageRoot(): string {
	let dir = path.dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 12; i++) {
		const pkgPath = path.join(dir, "package.json");
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
				if (pkg.name === "@cove-framework/cove") return dir;
			} catch {
				// not the file we want — keep walking
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error("[cove] could not locate the cove package root — is the install intact?");
}

// ─── Target dir ──────────────────────────────────────────────────────────────

function ensureTargetWritable(targetDir: string, force: boolean): void {
	if (fs.existsSync(targetDir)) {
		if (!fs.statSync(targetDir).isDirectory()) {
			throw new Error(`[cove] target exists and is not a directory: ${targetDir}`);
		}
		const entries = fs.readdirSync(targetDir).filter((e) => e !== ".git" && e !== ".DS_Store");
		if (entries.length > 0 && !force) {
			throw new Error(
				`[cove] target directory is not empty: ${targetDir}\n` +
					"  Pass --force to scaffold into it anyway (existing files with the same name are overwritten).",
			);
		}
	} else {
		fs.mkdirSync(targetDir, { recursive: true });
	}
}

// ─── Copy ────────────────────────────────────────────────────────────────────

/** Copy a directory tree, dropping generated/test artifacts and the demo _cove resolvers. */
function copyTreeFiltered(src: string, dest: string): void {
	if (!fs.existsSync(src)) {
		throw new Error(`[cove] missing package source (broken install?): ${src}`);
	}
	fs.cpSync(src, dest, {
		recursive: true,
		filter: (from) => {
			const base = path.basename(from);
			// Convex regenerates _generated; cove regenerates _cove; tests aren't part of a starter.
			if (base === "_generated" || base === "_cove" || base === "__tests__" || base === ".DS_Store") {
				return false;
			}
			if (base.endsWith(".test.ts")) return false;
			return true;
		},
	});
}

// ─── Starter registries (appended to the vendored authoring files) ────────────

const AGENT_REGISTRY_APPEND = `
// ─── Your agents ─────────────────────────────────────────────────────────────
// \`cove dev\` / \`cove build\` read the \`registry\` export below and (re)generate
// convex/_cove/agentResolver.ts so the engine resolves agents by name
// (e.g. POST /agents/assistant). Add your agents to this map.
import { createAgent } from "../src/runtime/agent-definition.ts";

export const registry = defineAgentRegistry({
	assistant: createAgent(() => ({
		model: "anthropic/claude-sonnet-4-6",
		instructions: "You are a helpful assistant scaffolded by \`cove init\`.",
	})),
});
`;

const WORKFLOW_REGISTRY_APPEND = `
// ─── Your workflows ──────────────────────────────────────────────────────────
// Code-orchestrated runs over agents, addressable at POST /workflows/:name.
// \`cove dev\` / \`cove build\` read the \`workflows\` export and (re)generate
// convex/_cove/workflowResolver.ts. Start empty; add handlers with defineWorkflow().
export const workflows = defineWorkflowRegistry({});
`;

const TOOL_REGISTRY_APPEND = `
// ─── Your tools ──────────────────────────────────────────────────────────────
// Register custom model-callable tools by NAME so the durable engine can recover
// each tool's execute closure (it can't cross the workflow journal). Reference the
// same tool objects from your agents' \`tools\` arrays. \`cove dev\` / \`cove build\`
// read the \`tools\` export and (re)generate convex/_cove/toolResolver.ts.
// Start empty; add tools with defineTool() from "@cove-framework/cove/runtime".
export const tools = defineToolRegistry({});
`;

const EXTENSION_REGISTRY_APPEND = `
// ─── Your extensions ─────────────────────────────────────────────────────────
// Register extensions by NAME, then opt an agent in with \`extensions: ["<name>"]\`
// (or pass an inline factory). An extension factory wires registrations + hooks
// against the registration API — keep it pure (no IO/network); it re-runs per
// isolate. \`cove dev\` / \`cove build\` read the \`extensions\` export and (re)generate
// convex/_cove/extensionResolver.ts. Start empty.
export const extensions = defineExtensionRegistry({});
`;

function appendStarterRegistries(targetDir: string): void {
	fs.appendFileSync(path.join(targetDir, "convex", "agentRegistry.ts"), AGENT_REGISTRY_APPEND);
	fs.appendFileSync(path.join(targetDir, "convex", "workflowRegistry.ts"), WORKFLOW_REGISTRY_APPEND);
	fs.appendFileSync(path.join(targetDir, "convex", "toolRegistry.ts"), TOOL_REGISTRY_APPEND);
	fs.appendFileSync(path.join(targetDir, "convex", "extensionRegistry.ts"), EXTENSION_REGISTRY_APPEND);
}

// ─── Scaffolding files ────────────────────────────────────────────────────────

function writeScaffolding(targetDir: string, projectName: string, pkgRoot: string): void {
	const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as {
		version: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};

	writeFile(path.join(targetDir, "package.json"), `${JSON.stringify(buildProjectPackageJson(projectName, pkg), null, 2)}\n`);
	writeFile(path.join(targetDir, "cove.config.ts"), COVE_CONFIG_TS);
	writeFile(path.join(targetDir, "tsconfig.json"), TSCONFIG_JSON);
	writeFile(path.join(targetDir, ".gitignore"), GITIGNORE);
	writeFile(path.join(targetDir, ".env.example"), ENV_EXAMPLE);
	writeFile(path.join(targetDir, "README.md"), readme(projectName));
}

/** The new project's package.json: the cove CLI + client surfaces, plus the backend's direct deps. */
function buildProjectPackageJson(
	projectName: string,
	pkg: { version: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> },
): Record<string, unknown> {
	const dep = pkg.dependencies ?? {};
	const dev = pkg.devDependencies ?? {};
	// The vendored backend imports these directly; declare them so resolution doesn't rely on cove's hoisting.
	const dependencies: Record<string, string> = {
		"@cove-framework/cove": `^${pkg.version}`,
		...dep,
	};
	const pick = (name: string): Record<string, string> => (dev[name] ? { [name]: dev[name] } : {});
	return {
		name: projectName,
		version: "0.1.0",
		private: true,
		type: "module",
		scripts: {
			dev: "cove dev",
			build: "cove build",
			deploy: "cove deploy",
			convex: "convex dev",
		},
		dependencies: sortObject(dependencies),
		devDependencies: sortObject({
			...pick("typescript"),
			...pick("tsx"),
			...pick("@types/node"),
			// The vendored runtime (skill-frontmatter.ts) imports js-yaml, which ships no types of its own.
			...pick("@types/js-yaml"),
		}),
	};
}

const COVE_CONFIG_TS = `import { defineCoveConfig } from "@cove-framework/cove/cli";

// Cove project configuration. \`cove dev\`/\`build\`/\`deploy\` read this.
export default defineCoveConfig({
	convexDir: "convex",
});
`;

const TSCONFIG_JSON = `${JSON.stringify(
	{
		compilerOptions: {
			target: "ESNext",
			lib: ["ESNext", "DOM", "DOM.Iterable"],
			jsx: "react-jsx",
			module: "ESNext",
			moduleResolution: "Bundler",
			allowImportingTsExtensions: true,
			verbatimModuleSyntax: true,
			noEmit: true,
			strict: true,
			skipLibCheck: true,
			esModuleInterop: true,
			forceConsistentCasingInFileNames: true,
			isolatedModules: true,
			resolveJsonModule: true,
			types: ["node"],
		},
		include: ["src/**/*.ts", "src/**/*.tsx", "convex/**/*.ts", "cove.config.ts"],
		exclude: ["node_modules"],
	},
	null,
	2,
)}\n`;

const GITIGNORE = `node_modules/
convex/_generated/
.convex/
.env
.env.local
.env.*.local
*.log
.DS_Store
dist/
`;

const ENV_EXAMPLE = `# Provider keys + auth secrets belong in the Convex deployment env (set via \`npx convex env set\`),
# NOT in this file. This .env is only consulted by the cove CLI on your machine. Copy to .env to use it.

# Vercel AI Gateway (covers all providers) — or set a provider-specific key below.
# AI_GATEWAY_API_KEY=

# Direct provider keys (match the model id in your agent, e.g. "anthropic/claude-sonnet-4-6"):
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=
# GOOGLE_GENERATIVE_AI_API_KEY=
`;

function readme(projectName: string): string {
	return `# ${projectName}

A [Cove](https://github.com/cove-framework/cove) agent project — a Convex-native agent harness.

## Layout

- \`convex/\` — the agent engine + your authoring surface (you own this; it deploys to Convex).
  - \`agentRegistry.ts\` — declare your agents in the \`registry\` export.
  - \`workflowRegistry.ts\` — declare code-orchestrated workflows in the \`workflows\` export.
  - \`_cove/\` — generated by \`cove dev\`/\`build\` from your registries (do not edit).
- \`src/runtime/\` — the vendored, V8-safe core the engine imports (do not edit).
- \`cove.config.ts\` — project config.

## Getting started

\`\`\`bash
npm install
npx convex dev            # one-time: create/link a Convex deployment
npx convex env set AI_GATEWAY_API_KEY <your-key>   # or a provider key, e.g. ANTHROPIC_API_KEY
npm run dev               # codegen + validate, then start convex dev (watches your registries)
\`\`\`

Then call your agent over HTTP (the route name is the registry key):

\`\`\`bash
curl -X POST "$CONVEX_SITE_URL/agents/assistant" \\
  -H 'content-type: application/json' \\
  -d '{ "prompt": "Hello!" }'
\`\`\`

## Commands

- \`npm run dev\` — \`cove dev\`: codegen + validation, then \`convex dev\` (re-codegen on registry change).
- \`npm run build\` — \`cove build\`: validate + codegen + \`tsc --noEmit\`.
- \`npm run deploy\` — \`cove deploy\`: build (fail-closed), then \`convex deploy\`.

## Frontend (optional)

Talk to your deployed agent from React with the published client surfaces:

\`\`\`ts
import { CoveProvider, useAgentPrompt } from "@cove-framework/cove/react";
import { createCoveReactiveClient } from "@cove-framework/cove/sdk";
\`\`\`
`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce a directory basename into a valid npm package name. */
function sanitizePackageName(raw: string): string {
	const name = raw
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[._-]+/, "")
		.replace(/-+$/, "");
	return name.length > 0 ? name : "cove-app";
}

function sortObject(obj: Record<string, string>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of Object.keys(obj).sort()) out[key] = obj[key];
	return out;
}

function writeFile(filePath: string, contents: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, contents, "utf8");
}

function printNextSteps(targetDir: string, dirArg: string | undefined): void {
	// Prefer what the user typed; fall back to a relative path, but never an ugly ../../.. chain.
	let label: string | undefined;
	if (dirArg && dirArg !== ".") {
		const rel = path.relative(process.cwd(), targetDir);
		label = rel && !rel.startsWith("..") ? rel : dirArg;
	}
	success(`scaffolded a Cove project in ${blue(label ?? "the current directory")}`);
	console.error("");
	console.error("  Next steps:");
	if (label) console.error(`    cd ${label}`);
	console.error("    npm install");
	console.error("    npx convex dev          # link a Convex deployment");
	console.error(`    ${dim("npx convex env set AI_GATEWAY_API_KEY <key>")}`);
	console.error("    npm run dev");
	console.error("");
	note("Edit convex/agentRegistry.ts to add agents. See README.md.");
}
