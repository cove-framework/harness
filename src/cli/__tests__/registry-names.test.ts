// G2.4 CLI test — registry-names stable sorted indexing.
import { describe, expect, it } from "vitest";
import {
	agentVarName,
	builtModuleVarName,
	stableIndexedNames,
	workflowVarName,
} from "../lib/registry-names.ts";

describe("registry-names", () => {
	it("sanitizes keys to collision-free identifiers", () => {
		expect(agentVarName("triage", 0)).toBe("handler_triage_0");
		expect(workflowVarName("echo", 1)).toBe("workflow_echo_1");
		// Non-identifier chars collapse to underscores; leading/trailing stripped.
		expect(agentVarName("my-agent", 2)).toBe("handler_my_agent_2");
		expect(agentVarName("a.b/c", 3)).toBe("handler_a_b_c_3");
		// An all-symbol name falls back to the kind label.
		expect(builtModuleVarName("handler", "agent", "----", 4)).toBe("handler_agent_4");
	});

	it("assigns indices in sorted-key order (byte-stable across input order)", () => {
		const a = stableIndexedNames(["zeta", "alpha", "mid"]);
		const b = stableIndexedNames(["mid", "zeta", "alpha"]);
		expect(a).toEqual([
			["alpha", 0],
			["mid", 1],
			["zeta", 2],
		]);
		// Same set, different declared order → identical indexing (the byte-stability guarantee).
		expect(a).toEqual(b);
	});

	it("produces deterministic var names from stable indices", () => {
		const indexed = stableIndexedNames(["reviewer", "assistant"]);
		const names = indexed.map(([name, index]) => agentVarName(name, index));
		expect(names).toEqual(["handler_assistant_0", "handler_reviewer_1"]);
	});
});
