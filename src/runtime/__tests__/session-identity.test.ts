// Tests for task-session naming + delegation guards (src/runtime/session-identity.ts).
import { describe, expect, it } from "vitest";
import { SubagentNotDeclaredError, TaskDepthExceededError } from "../errors.ts";
import {
	assertPublicSessionName,
	assertSubagentDeclared,
	assertTaskDepth,
	createTaskSessionName,
	isTaskSessionName,
	MAX_TASK_DEPTH,
} from "../session-identity.ts";

describe("task-session naming", () => {
	it("builds and recognizes task session names", () => {
		const name = createTaskSessionName("default", "t1");
		expect(name).toBe("task:default:t1");
		expect(isTaskSessionName(name)).toBe(true);
		expect(isTaskSessionName("default")).toBe(false);
	});

	it("reserves the task: namespace for delegated tasks", () => {
		expect(() => assertPublicSessionName("default")).not.toThrow();
		expect(() => assertPublicSessionName("task:x")).toThrow(/reserved/);
	});
});

describe("assertTaskDepth", () => {
	it("throws TaskDepthExceededError at the ceiling", () => {
		expect(() => assertTaskDepth(0)).not.toThrow();
		expect(() => assertTaskDepth(MAX_TASK_DEPTH - 1)).not.toThrow();
		expect(() => assertTaskDepth(MAX_TASK_DEPTH)).toThrow(TaskDepthExceededError);
		expect(() => assertTaskDepth(1, 1)).toThrow(TaskDepthExceededError);
	});
});

describe("assertSubagentDeclared", () => {
	it("allows the default (undefined) subagent and declared names", () => {
		expect(() => assertSubagentDeclared(undefined, [])).not.toThrow();
		expect(() => assertSubagentDeclared("reviewer", ["reviewer", "researcher"])).not.toThrow();
	});
	it("throws SubagentNotDeclaredError for an undeclared name", () => {
		expect(() => assertSubagentDeclared("ghost", ["reviewer"])).toThrow(SubagentNotDeclaredError);
	});
});
