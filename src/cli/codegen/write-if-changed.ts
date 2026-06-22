// New (Convex backend) · @cove/cli — content-compare write helper.
// Ported from flue · @flue/cli · packages/cli/src/lib/build.ts (lines 215–232, the `additionalOutputs`
// write-if-changed loop). The only durable bit of flue's build worth keeping: never touch a generated file
// when its bytes are unchanged, so `convex dev`'s watcher does not churn and a no-op rebuild writes 0 files
// (the idempotency acceptance bar). Pure Node.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Write `content` to `filePath` only if the on-disk bytes differ (or the file is
 * absent). Returns `true` if a write happened, `false` for a no-op. Creates
 * parent directories as needed.
 */
export function writeIfChanged(filePath: string, content: string): boolean {
	const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : undefined;
	if (existing === content) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
	return true;
}
