// Tests for the registry constructs (convex/agentRegistry.ts + workflowRegistry.ts).
import { describe, expect, it } from "vitest";
import { createAgent } from "../../src/runtime/agent-definition.ts";
import {
	defineAgentRegistry,
	getRegisteredAgent,
	registerAgentRegistry,
	resetAgentRegistryForTests,
} from "../agentRegistry.ts";
import {
	defineWorkflow,
	defineWorkflowRegistry,
	getRegisteredWorkflow,
	registerWorkflowRegistry,
	resetWorkflowRegistryForTests,
} from "../workflowRegistry.ts";

const triage = createAgent(() => ({ model: "anthropic/claude-haiku-4-5" }));
const reviewer = createAgent(() => ({ model: "anthropic/claude-haiku-4-5" }));

describe("defineAgentRegistry", () => {
	it("builds an addressable registry with manifest + lookup", () => {
		const reg = defineAgentRegistry({ triage, reviewer });
		expect(reg.names).toEqual(["triage", "reviewer"]);
		expect(reg.has("triage")).toBe(true);
		expect(reg.get("reviewer")).toBe(reviewer);
		expect(reg.get("ghost")).toBeUndefined();
		expect(reg.listAgents()).toEqual([{ name: "triage" }, { name: "reviewer" }]);
	});

	it("rejects invalid names and non-createAgent values", () => {
		expect(() => defineAgentRegistry({ "1bad": triage })).toThrow(/must start with a letter/);
		expect(() => defineAgentRegistry({ "has space": triage })).toThrow();
		// biome-ignore lint/suspicious/noExplicitAny: testing a non-branded value
		expect(() => defineAgentRegistry({ ok: {} as any })).toThrow(/not a createAgent/);
	});

	it("registers an active registry resolvable by name", () => {
		resetAgentRegistryForTests();
		expect(getRegisteredAgent("triage")).toBeUndefined();
		registerAgentRegistry(defineAgentRegistry({ triage }));
		expect(getRegisteredAgent("triage")).toBe(triage);
		resetAgentRegistryForTests();
	});
});

describe("defineWorkflow / defineWorkflowRegistry", () => {
	it("returns the handler and validates it is callable", () => {
		const wf = defineWorkflow(async () => ({ ok: true }));
		expect(typeof wf).toBe("function");
		// biome-ignore lint/suspicious/noExplicitAny: testing a non-function value
		expect(() => defineWorkflow(123 as any)).toThrow(/requires a handler function/);
	});

	it("builds + registers a workflow registry resolvable by name", () => {
		const wf = defineWorkflow(async () => "done");
		const reg = defineWorkflowRegistry({ summarize: wf });
		expect(reg.has("summarize")).toBe(true);
		expect(reg.get("summarize")).toBe(wf);
		expect(() => defineWorkflowRegistry({ "bad name": wf })).toThrow();

		resetWorkflowRegistryForTests();
		registerWorkflowRegistry(reg);
		expect(getRegisteredWorkflow("summarize")).toBe(wf);
		resetWorkflowRegistryForTests();
	});
});
