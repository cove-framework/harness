// Mirrors flue · @flue/runtime · packages/runtime/src/index.ts (the pure/V8-safe subset).
/**
 * Public surface of the portable cove-harness runtime — the signature-compatible
 * subset of `@flue/runtime` that is pure/V8-safe and therefore shared between
 * the Convex backend (convex/**) and external consumers. Convex-bound surfaces
 * (dispatch, observe, inspect, providers registration, sandbox factory, HTTP)
 * are exported from the Convex app, not this barrel.
 *
 * Ported so far: agent definition, tools, errors, and the full type contract.
 * Later phases add: session-history, compaction, skill-frontmatter, mcp.
 */

export { createAgent, defineAgentProfile } from "./agent-definition.ts";
export { createCoveContext } from "./context.ts";
export type {
	CoveContextInit,
	CoveTransport,
	PromptSubmission,
	RequestSnapshot,
	SessionRef,
} from "./context.ts";
export { defineTool } from "./tool.ts";
export {
	AttachmentNotAvailableError,
	CoveError,
	ModelNotConfiguredError,
	OperationFailedError,
	ProviderRegistrationError,
	SandboxOperationUnsupportedError,
	SessionAlreadyExistsError,
	SessionBusyError,
	SessionDeletedError,
	SessionNotFoundError,
	SkillNotRegisteredError,
	SubagentNotDeclaredError,
	SubmissionInterruptedError,
	SubmissionRetryExhaustedError,
	SubmissionTimeoutError,
	TaskDepthExceededError,
	ToolInputValidationError,
	ToolNameConflictError,
	type ToolValidationIssue,
} from "./errors.ts";
export type {
	AgentCreateContext,
	AgentDispatchRequest,
	AgentHarnessOptions,
	AgentProfile,
	AgentRouteHandler,
	AgentRuntimeConfig,
	AttachedAgentEvent,
	BashFactory,
	BashLike,
	CallHandle,
	CompactionConfig,
	CompactionEntry,
	CreatedAgent,
	DispatchReceipt,
	DurabilityConfig,
	FileStat,
	CoveContext,
	CoveEvent,
	CoveFs,
	CoveHarness,
	CoveLogger,
	CoveSession,
	CoveSessions,
	LlmAssistantMessage,
	LlmImageContent,
	LlmMessage,
	LlmTextContent,
	LlmThinkingContent,
	LlmTool,
	LlmToolCall,
	LlmToolResultMessage,
	LlmTurnPurpose,
	LlmUserMessage,
	MessageEntry,
	ModelConfig,
	NamedAgentDispatchRequest,
	PackagedSkillDirectory,
	PackagedSkillFile,
	PromptImage,
	PromptModel,
	PromptOptions,
	PromptResponse,
	PromptResultResponse,
	PromptUsage,
	SandboxFactory,
	SessionData,
	SessionEntry,
	SessionEnv,
	SessionStore,
	SessionToolFactory,
	SessionToolFactoryOptions,
	ShellOptions,
	ShellResult,
	Skill,
	SkillOptions,
	SkillReference,
	TaskOptions,
	TaskSessionRef,
	ThinkingLevel,
	ToolArgs,
	ToolDefinition,
	ToolParameters,
	WorkflowRouteHandler,
} from "./types.ts";
export type {
	AgentMessage,
	AgentTool,
	ImageContent,
	ModelHandle,
} from "./messages.ts";
