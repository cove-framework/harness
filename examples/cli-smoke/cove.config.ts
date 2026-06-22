// cli-smoke fixture (G2.4 acceptance) — a VALID cove.config.ts.
// Points at the local convex/ dir and enables m3 skill packaging from ./skills (off by default; on here so
// `cove build` exercises the packaging path + emits cove.skills.json).
import { defineCoveConfig } from "../../src/cli/index.ts";

export default defineCoveConfig({
	convexDir: "convex",
	skills: ["skills"],
});
