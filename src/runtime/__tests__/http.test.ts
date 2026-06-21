// Tests for the pure HTTP error/render/validation layer (src/runtime/http.ts).
import { describe, expect, it } from "vitest";
import {
	AgentNotFoundError,
	configureErrorRendering,
	CoveHttpError,
	InvalidRequestError,
	MethodNotAllowedError,
	renderHttpError,
	validateAgentRequest,
} from "../http.ts";

describe("CoveHttpError hierarchy", () => {
	it("carries the right status + code", () => {
		expect(new MethodNotAllowedError("PUT").httpStatus).toBe(405);
		expect(new AgentNotFoundError("x").httpStatus).toBe(404);
		expect(new AgentNotFoundError("x").code).toBe("agent_not_found");
		expect(new InvalidRequestError("bad")).toBeInstanceOf(CoveHttpError);
	});
});

describe("renderHttpError", () => {
	it("renders a CoveHttpError onto the CoveApiError envelope", () => {
		const { status, body } = renderHttpError(new AgentNotFoundError("triage"));
		expect(status).toBe(404);
		expect(body.error).toMatchObject({ code: "agent_not_found", status: 404 });
		expect(body.error.message).toContain("triage");
	});

	it("redacts non-CoveHttpError details by default, exposes them in dev mode", () => {
		const r1 = renderHttpError(new Error("secret stack detail"));
		expect(r1.status).toBe(500);
		expect(r1.body.error.message).not.toContain("secret");

		configureErrorRendering({ devMode: true });
		const r2 = renderHttpError(new Error("secret stack detail"));
		expect(r2.body.error.message).toContain("secret");
		configureErrorRendering({ devMode: false });
	});
});

describe("validateAgentRequest", () => {
	it("accepts message/prompt + optional model/sessionName/result", () => {
		expect(validateAgentRequest({ message: "hi", model: "anthropic/claude-haiku-4-5" })).toEqual({
			message: "hi",
			model: "anthropic/claude-haiku-4-5",
			sessionName: undefined,
			resultSchema: undefined,
		});
		expect(validateAgentRequest({ prompt: "yo", sessionName: "s" }).message).toBe("yo");
		expect(validateAgentRequest({ message: "q", result: { type: "object" } }).resultSchema).toEqual({
			type: "object",
		});
	});

	it("rejects a missing/empty message or a non-object body", () => {
		expect(() => validateAgentRequest({})).toThrow(InvalidRequestError);
		expect(() => validateAgentRequest({ message: "" })).toThrow(InvalidRequestError);
		expect(() => validateAgentRequest("nope")).toThrow(InvalidRequestError);
		expect(() => validateAgentRequest(null)).toThrow(InvalidRequestError);
	});
});
