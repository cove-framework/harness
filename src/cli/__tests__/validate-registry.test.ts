// G2.4 CLI test — each invalid fixture scenario produces a single [cove] diagnostic.
// The five negative cases mirror examples/cli-smoke/invalid/*. Two (bad-name, not-branded) fail at
// defineAgentRegistry() construction; invalid-workflow fails at defineWorkflowRegistry(); missing-provider
// and undeclared-subagent fail in the validator layer (validateAgentRegistry).
import { describe, expect, it } from "vitest";
import { createAgent, defineAgentProfile } from "../../runtime/agent-definition.ts";
import { defineAgentRegistry } from "../../../convex/agentRegistry.ts";
import { defineWorkflowRegistry } from "../../../convex/workflowRegistry.ts";
import {
	CoveValidationError,
	validateAgentRegistry,
	validateWorkflowRegistry,
} from "../validation/validate-registry.ts";

describe("validate-registry — invalid fixtures", () => {
	it("missing-provider → [cove] no model configured", async () => {
		const registry = defineAgentRegistry({
			broken: createAgent(() => ({ instructions: "no model" })),
		});
		await expect(validateAgentRegistry(registry)).rejects.toThrow(/^\[cove\]/);
		await expect(validateAgentRegistry(registry)).rejects.toThrow(/does not configure a model/);
	});

	it("undeclared-subagent → [cove] subagent not present in the registry", async () => {
		const assistant = createAgent(() => ({
			model: "anthropic/claude-haiku-4-5",
			subagents: [defineAgentProfile({ name: "ghost", model: "anthropic/claude-haiku-4-5" })],
		}));
		const registry = defineAgentRegistry({ assistant });
		await expect(validateAgentRegistry(registry)).rejects.toThrow(
			/\[cove\] agent "assistant" declares subagent "ghost" not present in the registry/,
		);
	});

	it("bad-name → [cove] name regex (thrown at defineAgentRegistry construction)", () => {
		expect(() =>
			defineAgentRegistry({ "1bad": createAgent(() => ({ model: "anthropic/claude-haiku-4-5" })) }),
		).toThrow(/^\[cove\]/);
		expect(() =>
			defineAgentRegistry({ "1bad": createAgent(() => ({ model: "anthropic/claude-haiku-4-5" })) }),
		).toThrow(/must start with a letter/);
	});

	it("not-branded → [cove] not a createAgent value (thrown at defineAgentRegistry construction)", () => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: a deliberately non-branded value.
			defineAgentRegistry({ fake: { model: "anthropic/claude-haiku-4-5" } as any }),
		).toThrow(/\[cove\].*not a createAgent/);
	});

	it("invalid-workflow → [cove] not a defineWorkflow handler (thrown at defineWorkflowRegistry construction)", () => {
		expect(() =>
			// biome-ignore lint/suspicious/noExplicitAny: a deliberately non-handler value.
			defineWorkflowRegistry({ broken: { not: "a function" } as any }),
		).toThrow(/\[cove\].*not a defineWorkflow/);
	});
});

describe("validate-registry — valid registry passes", () => {
	it("an in-registry subagent + resolvable model validates", async () => {
		const reviewer = createAgent(() => ({ model: "anthropic/claude-haiku-4-5" }));
		const assistant = createAgent(() => ({
			model: "anthropic/claude-haiku-4-5",
			subagents: [defineAgentProfile({ name: "reviewer", model: "anthropic/claude-haiku-4-5" })],
		}));
		const registry = defineAgentRegistry({ assistant, reviewer });
		await expect(validateAgentRegistry(registry)).resolves.toBeUndefined();
	});

	it("model:false (require call-level selection) is allowed", async () => {
		const registry = defineAgentRegistry({ flexible: createAgent(() => ({ model: false })) });
		await expect(validateAgentRegistry(registry)).resolves.toBeUndefined();
	});

	it("a callable workflow handler validates", () => {
		const registry = defineWorkflowRegistry({ echo: (_ctx, input) => input });
		expect(() => validateWorkflowRegistry(registry)).not.toThrow();
	});

	it("CoveValidationError always carries the [cove] prefix", () => {
		expect(new CoveValidationError("boom").message).toBe("[cove] boom");
		expect(new CoveValidationError("[cove] already").message).toBe("[cove] already");
	});
});
