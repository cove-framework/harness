#!/usr/bin/env node
// Ported from flue · @flue/cli · packages/cli/bin/flue.ts → @cove/cli (bin/cove.ts).
// New (Convex backend). Keeps the parseArgs/printUsage/dispatch skeleton. DROPPED: run/connect/logs/docs/init,
// the supervise/IPC dev harness, the event renderer, @vercel/detect-agent, MiniSearch, @flue/sdk, BLUEPRINTS,
// and all Vite/Cloudflare plumbing. Commands: dev / build / deploy (+ a stubbed `add`, --help/--version).
// Flags: --root / --config / --env only (no --target/--output/--port). Rebranded `[flue]`→`[cove]`.
// `tsx` executes this TS entry (the bin/cove.mjs shim spawns it).

import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { build } from "../src/cli/commands/build.ts";
import { deploy } from "../src/cli/commands/deploy.ts";
import { dev } from "../src/cli/commands/dev.ts";
import { createEnvLoader, selectEnvFile } from "../src/cli/lib/env.ts";
import { resolveConfigPath } from "../src/cli/lib/config.ts";
import { error as cliError } from "../src/cli/lib/terminal.ts";

// ─── Usage ─────────────────────────────────────────────────────────────────

function printUsage(log: (message: string) => void = console.error) {
	log(
		"Usage:\n" +
			"  cove dev    [--root <path>] [--config <path>] [--env <path>]\n" +
			"  cove build  [--root <path>] [--config <path>] [--env <path>] [--skip-typecheck]\n" +
			"  cove deploy [--root <path>] [--config <path>] [--env <path>]\n" +
			"  cove add    (deferred — m7)\n" +
			"\n" +
			"Commands:\n" +
			"  dev    Run codegen + validation, then start `convex dev`; re-codegen on config/registry change.\n" +
			"  build  Load → validate → codegen → `tsc --noEmit`. Writes only changed files.\n" +
			"  deploy Build (fail-closed: validate before any deploy), then `convex deploy`.\n" +
			"  add    Scaffold a blueprint — deferred (m7).\n" +
			"\n" +
			"Flags:\n" +
			"  --root <path>    Project root. Default: current working directory.\n" +
			"  --config <path>  Path to a cove.config.{ts,mts,mjs,js,cjs,cts} file (relative to cwd).\n" +
			"                   Default: search the root dir (or cwd) for `cove.config.*`.\n" +
			"  --env <path>     Select one alternate .env-format file loaded before config.\n" +
			"                   Without --env, <project>/.env is loaded when present. Shell values win.\n" +
			"\n" +
			"Note: provider keys + auth secrets live in the Convex deployment env (set via `convex env`),\n" +
			"not in the CLI env. Set a model in `createAgent(() => ({ model: \"provider-id/model-id\" }))`.",
	);
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

interface CommonArgs {
	explicitRoot: string | undefined;
	configFile: string | undefined;
	envFile: string | undefined;
	/** Skip the `tsc --noEmit` gate (build only; convex dev typechecks). deploy ignores it (fail-closed). */
	skipTypecheck: boolean;
}

interface DevArgs extends CommonArgs {
	command: "dev";
}
interface BuildArgs extends CommonArgs {
	command: "build";
}
interface DeployArgs extends CommonArgs {
	command: "deploy";
}
interface AddArgs {
	command: "add";
}

type ParsedArgs = DevArgs | BuildArgs | DeployArgs | AddArgs;

const PARSE_OPTIONS = {
	root: { type: "string" },
	config: { type: "string" },
	env: { type: "string" },
	"skip-typecheck": { type: "boolean" },
} as const;

const KNOWN_FLAGS = new Set(["--root", "--config", "--env", "--skip-typecheck"]);

function fail(message: string, usage = false): never {
	console.error(message);
	if (usage) printUsage();
	process.exit(1);
}

function parseCommon(command: string, args: string[]): CommonArgs {
	const parsed = parseNodeArgs({
		args,
		options: PARSE_OPTIONS,
		allowPositionals: true,
		strict: false,
		tokens: true,
	});
	for (const token of parsed.tokens ?? []) {
		if (token.kind !== "option") continue;
		if (!KNOWN_FLAGS.has(token.rawName)) {
			fail(`Unknown flag for \`cove ${command}\`: ${token.rawName}`, true);
		}
	}
	if (parsed.positionals.length > 0) {
		fail(`Unexpected argument for \`cove ${command}\`: ${parsed.positionals[0]}`, true);
	}
	const values = parsed.values as Record<string, string | boolean | undefined>;
	return {
		explicitRoot: pathFlag(values.root as string | undefined, "--root"),
		configFile: stringFlag(values.config as string | undefined, "--config"),
		envFile: stringFlag(values.env as string | undefined, "--env"),
		skipTypecheck: values["skip-typecheck"] === true,
	};
}

function stringFlag(value: string | undefined, flag: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.length === 0) fail(`Missing value for ${flag}`);
	return value;
}

function pathFlag(value: string | undefined, flag: string): string | undefined {
	const v = stringFlag(value, flag);
	return v ? path.resolve(v) : undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
	const [command, ...rest] = argv;

	if (command === "--help" || command === "-h" || command === "help") {
		printUsage(console.log);
		process.exit(0);
	}
	if (command === "--version" || command === "-v") {
		const pkg = JSON.parse(
			fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as { version: string };
		console.log(pkg.version);
		process.exit(0);
	}

	if (command === "add") {
		return { command: "add" };
	}
	if (command === "dev") return { command: "dev", ...parseCommon("dev", rest) };
	if (command === "build") return { command: "build", ...parseCommon("build", rest) };
	if (command === "deploy") return { command: "deploy", ...parseCommon("deploy", rest) };

	printUsage();
	process.exit(1);
}

// ─── Env loading ─────────────────────────────────────────────────────────────

function loadCliEnvironment(args: CommonArgs): void {
	try {
		const cwd = process.cwd();
		const searchFrom = args.explicitRoot ?? cwd;
		const configPath =
			args.configFile !== undefined
				? resolveConfigPath({ cwd, configFile: args.configFile })
				: resolveConfigPath({ cwd: searchFrom, configFile: undefined });
		const baseDir = configPath ? path.dirname(configPath) : searchFrom;
		createEnvLoader(selectEnvFile(args.envFile, baseDir)).apply();
	} catch (err) {
		cliError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
	const args = parseArgs(process.argv.slice(2));

	if (args.command === "add") {
		console.error("[cove] cove add is deferred (m7); see roadmap P8.5.");
		process.exit(0);
	}

	loadCliEnvironment(args);

	try {
		if (args.command === "dev") {
			await dev({ explicitRoot: args.explicitRoot, configFile: args.configFile });
			return;
		}
		if (args.command === "build") {
			await build({
				explicitRoot: args.explicitRoot,
				configFile: args.configFile,
				log: "verbose",
				skipTypecheck: args.skipTypecheck,
			});
			return;
		}
		if (args.command === "deploy") {
			const code = await deploy({ explicitRoot: args.explicitRoot, configFile: args.configFile });
			process.exit(code);
		}
	} catch (err) {
		cliError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	}
}

void main();
