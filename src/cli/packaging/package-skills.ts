// Ported from flue · @flue/cli · packages/cli/src/lib/vite-import-attribute-plugin.ts → @cove/cli.
// New (Convex backend). STRIPPED: the Vite plugin shell, `with { type: 'skill' }` / `with { type: 'markdown' }`
// attribute machinery, virtual modules, AST walks. KEPT VERBATIM (these are a security boundary, doc 08 D13/
// §Risks): the constants EXCLUDED_DIRECTORIES / SENSITIVE_DIRECTORIES / EXCLUDED_FILES /
// SENSITIVE_FILE_PATTERNS and the functions packageSkill / collectFiles / isSensitiveFile / isExcludedFile /
// isTextContent. `__flueSkillReference`→`__coveSkillReference`. Emits `cove.skills.json` (a catalog-import
// payload) instead of a `virtual:flue/packaged-skills` module.
//
// m3 is OPT-IN: only runs when `config.skills` is set. Packaging reads SKILL.md from the HOST/REPO at build
// time (D13: skills resolve at the call site, NOT from a sandbox FS at runtime) — this is the authoring side.
// Reuses the existing parseSkillMarkdown (src/runtime/skill-frontmatter.ts); does not re-port it.

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSkillMarkdown } from "../../runtime/skill-frontmatter.ts";
import type {
	PackagedSkillDirectory,
	PackagedSkillFile,
	SkillReference,
} from "../../runtime/types.ts";
import { writeIfChanged } from "../codegen/write-if-changed.ts";

const PACKAGED_FILE_WARNING_BYTES = 1024 * 1024;
const EXCLUDED_DIRECTORIES = new Set([".git", ".cache", ".turbo", ".wrangler", "dist", "node_modules"]);
const SENSITIVE_DIRECTORIES = new Set([".aws", ".gnupg", ".ssh"]);
const EXCLUDED_FILES = new Set([".netrc", ".npmrc", ".pypirc", "_netrc", "credentials.json"]);
const SENSITIVE_FILE_PATTERNS = [/\.key$/i, /\.pem$/i, /\.p12$/i, /\.pfx$/i, /^secrets?(?:\.|$)/i];

/** The cove.skills.json payload shape: a catalog of packaged skill directories + their references. */
export interface CoveSkillsCatalog {
	readonly skills: Array<{
		readonly reference: SkillReference;
		readonly directory: PackagedSkillDirectory;
	}>;
}

/**
 * Package the skills found under each `config.skills` source dir into a
 * `cove.skills.json` catalog written at `<root>/cove.skills.json`. Each source
 * dir is treated as a *parent* of one-or-more `<name>/SKILL.md` skill dirs; a
 * source dir that IS a skill dir (contains SKILL.md directly) is also accepted.
 *
 * Throws (does NOT skip) when a skill dir contains a sensitive file/dir — the
 * security boundary is fail-closed. Returns whether cove.skills.json changed.
 */
export async function packageSkills(opts: {
	root: string;
	skillSources: string[];
}): Promise<{ path: string; changed: boolean; count: number }> {
	const skillDirs = discoverSkillDirectories(opts.skillSources);
	const skills: CoveSkillsCatalog["skills"] = [];
	for (const dir of skillDirs) {
		const skillPath = path.join(dir, "SKILL.md");
		const directory = await packageSkill(skillPath);
		const reference: SkillReference = {
			__coveSkillReference: true,
			id: directory.id,
			name: directory.name,
			description: directory.description,
		};
		skills.push({ reference, directory });
	}
	// Sort by id for byte-stable output.
	skills.sort((a, b) => (a.reference.id < b.reference.id ? -1 : a.reference.id > b.reference.id ? 1 : 0));
	const catalog: CoveSkillsCatalog = { skills };
	const filePath = path.join(opts.root, "cove.skills.json");
	const content = `${JSON.stringify(catalog, null, 2)}\n`;
	const changed = writeIfChanged(filePath, content);
	return { path: filePath, changed, count: skills.length };
}

/** Resolve each source dir to the set of skill dirs (those containing SKILL.md). */
function discoverSkillDirectories(sources: string[]): string[] {
	const dirs = new Set<string>();
	for (const source of sources) {
		if (!fs.existsSync(source)) {
			throw new Error(`[cove] skill source "${source}" does not exist.`);
		}
		const stat = fs.statSync(source);
		if (!stat.isDirectory()) {
			throw new Error(`[cove] skill source "${source}" must be a directory.`);
		}
		// A source dir that directly contains SKILL.md is itself a skill dir.
		if (fs.existsSync(path.join(source, "SKILL.md"))) {
			dirs.add(source);
			continue;
		}
		// Otherwise treat each child dir that contains SKILL.md as a skill dir.
		for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const child = path.join(source, entry.name);
			if (fs.existsSync(path.join(child, "SKILL.md"))) dirs.add(child);
		}
	}
	return [...dirs].sort();
}

// ─── Ported verbatim (sans Vite normalizePath; using path.posix for stable keys) ──

async function packageSkill(skillPath: string): Promise<PackagedSkillDirectory> {
	const directory = path.dirname(skillPath);
	const parsed = parseSkillMarkdown(await fs.promises.readFile(skillPath, "utf8"), {
		directoryName: path.basename(directory),
		path: skillPath,
	});
	const files: Record<string, PackagedSkillFile> = {};
	const hash = createHash("sha256");
	for (const filePath of await collectFiles(directory)) {
		const relativePath = posix(path.relative(directory, filePath));
		const content = await fs.promises.readFile(filePath);
		if (content.byteLength > PACKAGED_FILE_WARNING_BYTES) {
			console.warn(
				`[cove] Skill file "${filePath}" exceeds 1MB and will be packaged into the deployed application for lazy access.`,
			);
		}
		const pathBuffer = Buffer.from(relativePath);
		const lengths = Buffer.allocUnsafe(8);
		lengths.writeUInt32BE(pathBuffer.byteLength, 0);
		lengths.writeUInt32BE(content.byteLength, 4);
		hash.update(lengths);
		hash.update(pathBuffer);
		hash.update(content);
		files[relativePath] = {
			encoding: "base64",
			kind: isTextContent(content) ? "text" : "binary",
			content: content.toString("base64"),
		};
	}
	return {
		id: `skill:${parsed.name}:${hash.digest("hex").slice(0, 16)}`,
		name: parsed.name,
		description: parsed.description,
		files,
	};
}

async function collectFiles(directory: string, skillRoot = directory): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
		const absolutePath = path.join(directory, entry.name);
		const relativePath = posix(path.relative(skillRoot, absolutePath));
		if (entry.isSymbolicLink()) {
			throw new Error(
				`[cove] Skill directory "${skillRoot}" contains symbolic link "${relativePath}", which cannot be packaged. Replace it with a regular file or directory.`,
			);
		}
		if (entry.isDirectory()) {
			if (EXCLUDED_DIRECTORIES.has(entry.name)) {
				console.warn(
					`[cove] Excluding skill directory "${relativePath}" from the deployed application package because it is generated or repository metadata.`,
				);
				continue;
			}
			if (SENSITIVE_DIRECTORIES.has(entry.name.toLowerCase())) {
				throw new Error(
					`[cove] Imported skill directory "${skillRoot}" contains sensitive directory "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			files.push(...(await collectFiles(absolutePath, skillRoot)));
		} else if (entry.isFile()) {
			if (isSensitiveFile(entry.name)) {
				throw new Error(
					`[cove] Imported skill directory "${skillRoot}" contains sensitive file "${relativePath}", which cannot be packaged. Remove credentials and private keys from the skill directory.`,
				);
			}
			if (isExcludedFile(entry.name)) {
				console.warn(
					`[cove] Excluding skill file "${relativePath}" from the deployed application package because it is generated content.`,
				);
				continue;
			}
			files.push(absolutePath);
		}
	}
	return files.sort();
}

function isSensitiveFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		EXCLUDED_FILES.has(lowerFilename) ||
		lowerFilename === ".dev.vars" ||
		lowerFilename.startsWith(".dev.vars.") ||
		lowerFilename === ".env" ||
		lowerFilename.startsWith(".env.") ||
		SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(filename))
	);
}

function isExcludedFile(filename: string): boolean {
	const lowerFilename = filename.toLowerCase();
	return (
		lowerFilename === ".ds_store" ||
		lowerFilename.endsWith(".swp") ||
		lowerFilename.endsWith(".swo") ||
		lowerFilename.endsWith("~")
	);
}

function isTextContent(content: Buffer): boolean {
	if (content.includes(0)) return false;
	const text = content.toString("utf8");
	return Buffer.from(text, "utf8").equals(content) && !text.includes("�");
}

/** Normalize a path to forward slashes (replaces Vite's normalizePath). */
function posix(p: string): string {
	return p.split(path.sep).join("/");
}

// Exported for tests.
export const __testing = { packageSkill, collectFiles, isSensitiveFile, isExcludedFile, isTextContent };
