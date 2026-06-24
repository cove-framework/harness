// Tests for the Phase 1 authoring-surface changes (src/runtime/agent-definition.ts):
// the mcpServers strict-schema fix, the new `extensions` field, and threading both
// through resolveAgentProfile.
import { describe, expect, it } from "vitest";
import { defineAgentProfile, resolveAgentProfile } from "../agent-definition.ts";

describe("mcpServers (regression: was rejected by the strict schema)", () => {
	it("accepts a valid mcpServers array on a profile", () => {
		expect(() =>
			defineAgentProfile({
				model: "anthropic/claude-sonnet-4-6",
				mcpServers: [{ name: "fs", url: "https://example.com/mcp", transport: "streamable-http" }],
			}),
		).not.toThrow();
	});

	it("accepts mcpServers on a createAgent runtime config (auto-allowlisted)", () => {
		const resolved = resolveAgentProfile({
			model: "anthropic/claude-sonnet-4-6",
			mcpServers: [{ name: "fs", url: "https://example.com/mcp" }],
		});
		expect(resolved.mcpServers).toEqual([{ name: "fs", url: "https://example.com/mcp" }]);
	});

	it("rejects a server missing a name or url", () => {
		expect(() => defineAgentProfile({ mcpServers: [{ url: "https://x" } as never] })).toThrow(
			/name must be a non-empty string/,
		);
		expect(() => defineAgentProfile({ mcpServers: [{ name: "fs" } as never] })).toThrow(
			/url must be a string or URL/,
		);
	});

	it("rejects an unknown transport", () => {
		expect(() =>
			defineAgentProfile({ mcpServers: [{ name: "fs", url: "https://x", transport: "ws" as never }] }),
		).toThrow(/transport must be one of/);
	});

	it("rejects duplicate server names", () => {
		expect(() =>
			defineAgentProfile({
				mcpServers: [
					{ name: "fs", url: "https://a" },
					{ name: "fs", url: "https://b" },
				],
			}),
		).toThrow(/duplicate MCP server name "fs"/);
	});
});

describe("extensions field", () => {
	it("accepts registered names and inline factories", () => {
		const inline = () => {};
		expect(() =>
			defineAgentProfile({ extensions: ["audit-log", inline] }),
		).not.toThrow();
	});

	it("rejects empty-string and non-string/non-function entries", () => {
		expect(() => defineAgentProfile({ extensions: [""] })).toThrow(
			/registered extension name \(string\) or an extension factory/,
		);
		expect(() => defineAgentProfile({ extensions: [123 as never] })).toThrow(
			/registered extension name \(string\) or an extension factory/,
		);
	});

	it("rejects duplicate extension names (factories are exempt)", () => {
		expect(() => defineAgentProfile({ extensions: ["a", "a"] })).toThrow(
			/duplicate extension name "a"/,
		);
		// two anonymous factories are not "duplicates"
		expect(() => defineAgentProfile({ extensions: [() => {}, () => {}] })).not.toThrow();
	});
});

describe("resolveAgentProfile threading + merge", () => {
	it("threads mcpServers + extensions and merges profile + config", () => {
		const factory = () => {};
		const resolved = resolveAgentProfile({
			profile: {
				name: "base",
				mcpServers: [{ name: "fs", url: "https://fs" }],
				extensions: ["base-ext"],
			},
			mcpServers: [{ name: "db", url: "https://db" }],
			extensions: [factory],
		});
		expect(resolved.mcpServers).toEqual([
			{ name: "fs", url: "https://fs" },
			{ name: "db", url: "https://db" },
		]);
		expect(resolved.extensions).toEqual(["base-ext", factory]);
	});

	it("still rejects genuinely unknown runtime config fields", () => {
		expect(() => resolveAgentProfile({ bogus: 1 } as never)).toThrow(
			/unknown runtime config field "bogus"/,
		);
	});
});
