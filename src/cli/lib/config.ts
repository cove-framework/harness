// Ported from flue · @flue/cli · packages/cli/src/lib/config.ts → @cove/cli.
// New (Convex backend). `defineConfig`→`defineCoveConfig`; reuses the resolveConfigPath/loadConfigModule/
// resolveConfig skeleton. TRIMMED vs. flue: dropped `target` (Convex is the only backend, D12),
// `output`/`sourceRoot` (no Vite bundle; codegen writes into convex/_cove/), and the output-vs-root guard.
// Kept `root`; added `convexDir` (default "convex") + `skills` (optional m3 source dirs, off by default).
// loadConfigModule keeps Node's native TS-strip dynamic import with the ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX hint.

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// ─── Authoring API ───────────────────────────────────────────────────────────

/**
 * Configuration authored in `cove.config.ts`. Only the fields declared by this
 * interface are accepted.
 */
export interface UserCoveConfig {
	/**
	 * Project root. Must not be empty. Relative values loaded from a config file
	 * resolve from the directory containing that file; relative inline values
	 * resolve from the caller's working directory. Defaults to the config
	 * directory, or to the search directory when no config file is loaded.
	 */
	root?: string;
	/**
	 * Directory (relative to root, or absolute) holding the Convex app — the
	 * `agentRegistry.ts` / `workflowRegistry.ts` authoring surface, the generated
	 * `_cove/` resolvers, and `http.ts`. Defaults to `"convex"`.
	 */
	convexDir?: string;
	/**
	 * Optional m3 skill source directories (each containing a `<name>/SKILL.md`).
	 * Packaging is off by default; only runs when this is set. Paths resolve from
	 * the config dir (file values) or cwd (inline values).
	 */
	skills?: string[];
}

/** Fully resolved configuration consumed by the rest of the CLI. */
export interface CoveConfig {
	/** Absolute project-root path. */
	root: string;
	/** Absolute path to the Convex app directory (default `<root>/convex`). */
	convexDir: string;
	/** Absolute skill source dirs for m3 packaging (empty = packaging off). */
	skills: string[];
}

/**
 * Provides type checking + editor completion for `cove.config.ts`. Returns the
 * configuration unchanged.
 *
 * ```ts
 * import { defineCoveConfig } from "cove/cli";
 *
 * export default defineCoveConfig({ convexDir: "convex" });
 * ```
 */
export function defineCoveConfig(config: UserCoveConfig): UserCoveConfig {
	return config;
}

// ─── Discovery ─────────────────────────────────────────────────────────────

/** Config file basenames searched in order. */
export const CONFIG_BASENAMES = [
	"cove.config.ts",
	"cove.config.mts",
	"cove.config.mjs",
	"cove.config.js",
	"cove.config.cjs",
	"cove.config.cts",
] as const;

export interface ResolveConfigPathOptions {
	/** Working directory for config discovery and relative `configFile` paths. */
	cwd: string;
	/** Explicit config-file path (relative to `cwd`, or absolute). */
	configFile?: string;
}

/**
 * Resolve the absolute path of the user's `cove.config.*` file, or `undefined`
 * if none is found and the user didn't ask for one. Throws if `configFile` is
 * an explicit path that doesn't exist — that's a typo, not "config not set".
 */
export function resolveConfigPath(opts: ResolveConfigPathOptions): string | undefined {
	const cwd = path.resolve(opts.cwd);
	if (opts.configFile) {
		const explicit = path.resolve(cwd, opts.configFile);
		if (!fs.existsSync(explicit)) {
			throw new Error(`[cove] Config file not found: ${opts.configFile}`);
		}
		return explicit;
	}
	for (const basename of CONFIG_BASENAMES) {
		const candidate = path.join(cwd, basename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** All config-file candidate paths (for the dev watcher). */
export function resolveConfigCandidates(opts: { cwd: string; searchFrom?: string; configFile?: string }): string[] {
	const cwd = path.resolve(opts.cwd);
	const searchFrom = path.resolve(opts.searchFrom ?? cwd);
	if (opts.configFile) return [path.resolve(cwd, opts.configFile)];
	return CONFIG_BASENAMES.map((basename) => path.join(searchFrom, basename));
}

// ─── Loading ───────────────────────────────────────────────────────────────

/**
 * Load a config file's `default` export via Node's native dynamic `import()`
 * (plain JS, ESM, and TypeScript via type-stripping on Node ≥ 22.18 / ≥ 23.6).
 * Cache-busts via a query param so repeated loads (dev-server config watcher)
 * get a fresh module. Repackages strip-mode errors with a hint.
 */
async function loadConfigModule(absConfigPath: string): Promise<unknown> {
	const fileUrl = `${pathToFileURL(absConfigPath).href}?t=${Date.now()}`;
	try {
		const mod = await import(fileUrl);
		return mod.default ?? mod;
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX") {
			throw new Error(
				`[cove] ${path.basename(absConfigPath)} uses TypeScript syntax that Node's ` +
					`type-stripping loader doesn't support (e.g. \`enum\`, \`namespace\` with ` +
					`runtime code, parameter properties, decorators). Rewrite using only ` +
					`erasable types (or move the config to plain JS).\n  Original: ${(err as Error).message}`,
			);
		}
		if (code === "ERR_UNKNOWN_FILE_EXTENSION") {
			throw new Error(
				`[cove] Cannot load ${path.basename(absConfigPath)}: this Node ` +
					`(v${process.versions.node}) does not support TypeScript natively. ` +
					`Upgrade to Node ≥ 22.18 or ≥ 23.6.`,
			);
		}
		throw err;
	}
}

// ─── Resolution ──────────────────────────────────────────────────────────────

export interface ResolveConfigOptions {
	/** Caller's working directory; default search base for config discovery. */
	cwd: string;
	/** Optional starting directory for config discovery. Defaults to `cwd`. */
	searchFrom?: string;
	/** Explicit config-file path relative to `cwd`. */
	configFile?: string;
	/** Inline overrides. Only fields the caller supplied should be present. */
	inline?: UserCoveConfig;
}

export interface ResolvedConfigResult {
	/** Absolute path of the loaded config file, or undefined if none. */
	configPath: string | undefined;
	/** The fully-resolved config consumed by the rest of the CLI. */
	coveConfig: CoveConfig;
}

/**
 * Discover, load, validate, merge, and resolve a Cove config. The single entry
 * point the CLI commands call. Precedence (highest first): inline → file →
 * defaults. Throws on a malformed config file.
 */
export async function resolveConfig(opts: ResolveConfigOptions): Promise<ResolvedConfigResult> {
	const cwd = path.resolve(opts.cwd);
	const searchFrom = path.resolve(opts.searchFrom ?? cwd);

	const configPath =
		opts.configFile !== undefined
			? resolveConfigPath({ cwd, configFile: opts.configFile })
			: resolveConfigPath({ cwd: searchFrom, configFile: undefined });

	let fileConfig: UserCoveConfig = {};
	if (configPath) {
		const raw = await loadConfigModule(configPath);
		if (raw == null || typeof raw !== "object") {
			throw new Error(
				`[cove] ${path.relative(cwd, configPath) || configPath} must export a config object as the default export.`,
			);
		}
		fileConfig = validateUserConfig(raw, configPath);
	}

	const configDir = configPath ? path.dirname(configPath) : searchFrom;
	const inline = validateUserConfig(opts.inline ?? {}, "inline options");

	const merged: UserCoveConfig = {
		root: inline.root ?? fileConfig.root,
		convexDir: inline.convexDir ?? fileConfig.convexDir,
		skills: inline.skills ?? fileConfig.skills,
	};

	// Inline values resolve from cwd; file values resolve from the config dir.
	const root = resolvePath(merged.root, {
		baseDir: inline.root === undefined ? configDir : cwd,
		fallback: configDir,
	});

	const convexDir = resolvePath(merged.convexDir, {
		baseDir: root,
		fallback: path.join(root, "convex"),
	});

	const skillsBase = merged.skills === inline.skills && inline.skills !== undefined ? cwd : configDir;
	const skills = (merged.skills ?? []).map((dir) =>
		path.isAbsolute(dir) ? dir : path.resolve(skillsBase, dir),
	);

	return {
		configPath,
		coveConfig: { root, convexDir, skills },
	};
}

/** Resolve a possibly-relative path to an absolute one. */
function resolvePath(value: string | undefined, opts: { baseDir: string; fallback: string }): string {
	if (value === undefined) return opts.fallback;
	if (path.isAbsolute(value)) return value;
	return path.resolve(opts.baseDir, value);
}

/** Minimal hand-rolled validation (flue used valibot; the surface here is tiny). */
function validateUserConfig(raw: unknown, where: string): UserCoveConfig {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error(`[cove] Invalid config in ${where}: expected an object.`);
	}
	const obj = raw as Record<string, unknown>;
	const allowed = new Set(["root", "convexDir", "skills"]);
	for (const key of Object.keys(obj)) {
		if (!allowed.has(key)) {
			throw new Error(`[cove] Invalid config in ${where}: unknown field "${key}".`);
		}
	}
	const out: UserCoveConfig = {};
	if (obj.root !== undefined) {
		if (typeof obj.root !== "string" || obj.root.length === 0) {
			throw new Error(`[cove] Invalid config in ${where}: \`root\` must be a non-empty string.`);
		}
		out.root = obj.root;
	}
	if (obj.convexDir !== undefined) {
		if (typeof obj.convexDir !== "string" || obj.convexDir.length === 0) {
			throw new Error(`[cove] Invalid config in ${where}: \`convexDir\` must be a non-empty string.`);
		}
		out.convexDir = obj.convexDir;
	}
	if (obj.skills !== undefined) {
		if (!Array.isArray(obj.skills) || obj.skills.some((s) => typeof s !== "string" || s.length === 0)) {
			throw new Error(`[cove] Invalid config in ${where}: \`skills\` must be an array of non-empty strings.`);
		}
		out.skills = obj.skills as string[];
	}
	return out;
}
