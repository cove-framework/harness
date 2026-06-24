// Ported from flue · @flue/runtime · packages/runtime/src/types.ts.
// pi imports → ./messages.ts; hono MiddlewareHandler → local route-handler type;
// pi-ai Model<any> → ./messages.ts ModelHandle.
import type * as v from "valibot";
import type {
	AgentMessage,
	AgentTool,
	ImageContent,
	ModelHandle,
	ThinkingLevel,
} from "./messages.ts";
import type { ToolDefinition } from "./tool-types.ts";
import type { McpServerOptions } from "./mcp-types.ts";

export type {
	ToolArgs,
	ToolDefinition,
	ToolParameters,
	ToolResult,
	ToolResultContent,
	ToolResultContentImage,
	ToolResultContentText,
} from "./tool-types.ts";
export type { ThinkingLevel } from "./messages.ts";

/**
 * Route middleware handler. flue used hono's `MiddlewareHandler`; cove-harness is
 * Convex-native, so this is a structural handler used by the pluggable auth hook
 * over the HTTP submit/poll surface (convex/http.ts). `c` carries the request +
 * env; call `next()` to continue.
 */
export type AgentRouteHandler = (
	c: { req: Request; env: Record<string, any> },
	next: () => Promise<void>,
) => Promise<void | Response> | void | Response;
export type WorkflowRouteHandler = AgentRouteHandler;

/** Input accepted by the created-agent overload of `dispatch(...)`. */
export interface AgentDispatchRequest {
	/** Target agent instance id. Must be a non-empty string. */
	id: string;
	/**
	 * JSON-like input delivered to the session. Required; use `null` for an
	 * intentional empty payload. Cove snapshots the value at admission time.
	 */
	input: unknown;
}

/** Input accepted by the named-agent overload of `dispatch(...)`. */
export interface NamedAgentDispatchRequest extends AgentDispatchRequest {
	/** Registered agent name. Must be a non-empty string. */
	agent: string;
}

/** Receipt returned after a dispatched input is accepted for delivery. */
export interface DispatchReceipt {
	/** Generated delivery identifier. This is not a workflow `runId`. */
	dispatchId: string;
	/** ISO timestamp assigned when dispatch admission begins. */
	acceptedAt: string;
}

export interface DirectAgentPayload {
	message: string;
	images?: PromptImage[];
}

/** Context passed to a {@link createAgent} initializer. */
export interface AgentCreateContext<TPayload = unknown, TEnv = Record<string, any>> {
	/** Agent instance id, or workflow run id when initialized with `ctx.init()`. */
	readonly id: string;
	/** Platform environment bindings supplied by the runtime. */
	readonly env: TEnv;
	/** Workflow payload when initialized with `ctx.init()`; otherwise `undefined`. */
	readonly payload: TPayload | undefined;
}

/**
 * Inline image content attached to a `prompt()`, `skill()`, or `task()` call.
 * Re-exports the `ImageContent` shape: `{ type: 'image', data: base64, mimeType }`.
 * The selected model must support vision input.
 */
export type PromptImage = ImageContent;

// ─── Skill ──────────────────────────────────────────────────────────────────

/** Imported packaged skill reference accepted by `session.skill()`. */
export interface SkillReference {
	readonly __coveSkillReference: true;
	readonly id: string;
	readonly name: string;
	readonly description: string;
}

export interface PackagedSkillFile {
	readonly encoding: "base64";
	readonly kind: "text" | "binary";
	readonly content: string;
}

export interface PackagedSkillDirectory {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly files: Record<string, PackagedSkillFile>;
}

/** Skill metadata registered with an agent, harness, or profile. */
export type Skill =
	| SkillReference
	| {
			name: string;
			description: string;
	  };

// ─── File Stat ──────────────────────────────────────────────────────────────

/**
 * File metadata returned by {@link CoveFs.stat}. `isSymbolicLink`, `size`, and
 * `mtime` are omitted when the sandbox adapter's provider does not expose them —
 * adapters must never fabricate placeholder values.
 */
export interface FileStat {
	isFile: boolean;
	isDirectory: boolean;
	isSymbolicLink?: boolean;
	size?: number;
	mtime?: Date;
}

// ─── Session Environment ────────────────────────────────────────────────────

/**
 * Universal session environment interface. All sandbox modes (isolate, local,
 * remote) implement this — no mode-specific branching in core logic. File
 * methods accept both absolute and relative paths (resolved against `cwd`).
 */
export interface SessionEnv {
	exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			/**
			 * Wall-clock deadline hint in milliseconds. Forwarded to the underlying
			 * sandbox adapter's native timeout option so signal-blind providers still
			 * observe the deadline. Adapters may round up, never down.
			 */
			timeoutMs?: number;
			/**
			 * Cancel the in-flight command. Aborting rejects with an `AbortError`.
			 * Signal-aware adapters observe this mid-flight; others only before/after
			 * the remote call returns. Use `timeoutMs` for guaranteed enforcement.
			 */
			signal?: AbortSignal;
		},
	): Promise<ShellResult>;

	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	/** Creates missing parent directories (the `CoveFs.writeFile` guarantee). */
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;

	cwd: string;

	/**
	 * Resolve a relative path against cwd. Absolute paths pass through. File
	 * methods resolve internally — only needed when you need the absolute path for
	 * your own logic (e.g., extracting the parent directory).
	 */
	resolvePath(p: string): string;
}

/**
 * Filesystem surface for the harness sandbox, exposed on `CoveHarness.fs` and
 * `CoveSession.fs`. Operations are out-of-band — they don't appear in the
 * conversation transcript. Paths can be absolute or relative (relative resolved
 * against the agent's cwd).
 */
export interface CoveFs {
	readFile(path: string): Promise<string>;
	readFileBuffer(path: string): Promise<Uint8Array>;
	/**
	 * Write content to a file, creating missing parent directories automatically
	 * in every sandbox mode. The runtime implements this guarantee itself, so
	 * adapters don't need to create parents in their `writeFile`.
	 */
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	stat(path: string): Promise<FileStat>;
	readdir(path: string): Promise<string[]>;
	/** True if a file or directory exists at `path`. Never throws. */
	exists(path: string): Promise<boolean>;
	mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
	rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
}

// ─── Compaction ─────────────────────────────────────────────────────────────

export interface CompactionConfig {
	/**
	 * Token headroom to reserve in the context window. Compaction triggers when
	 * used tokens exceed `contextWindow - reserveTokens`. Defaults to a
	 * model-aware value capped at 20000 tokens.
	 */
	reserveTokens?: number;
	/**
	 * Recent tokens to preserve unsummarized after compaction. Older messages are
	 * folded into a summary; this many tokens of recent history remain verbatim.
	 * Defaults to 8000.
	 */
	keepRecentTokens?: number;
	/**
	 * Override the model used for summarization. Defaults to the session's model.
	 * Format: `'provider-id/model-id'`.
	 */
	model?: string;
}

// ─── Durability ─────────────────────────────────────────────────────────────

export interface DurabilityConfig {
	/**
	 * Maximum total attempts before the submission is terminalized as failed. The
	 * initial run counts as the first attempt; each reset/deploy that interrupts a
	 * running submission consumes another. Defaults to 10.
	 */
	maxAttempts?: number;
	/**
	 * Maximum wall-clock milliseconds for a single submission. Submissions that
	 * exceed this are aborted and settled as failed. Defaults to 3,600,000 (1h).
	 */
	timeoutMs?: number;
	/**
	 * Defense-in-depth ceiling on agent-loop steps per submission. NOT flue's model —
	 * flue has no framework turn cap (the model terminalizes via finish/give_up); this
	 * only catches a runaway loop. Resolved at setup and frozen onto the plan; reaching
	 * it terminalizes the request as failed with a `step_limit_exceeded` reason.
	 * Defaults to 100. See doc 08 §4.9.
	 */
	maxSteps?: number;
	/**
	 * Max result-tool re-nudges for a result-schema run before it terminalizes as
	 * failed with a `result_followups_exhausted` reason (the CallHandle then rejects
	 * with `ResultUnavailableError`, never resolving an unvalidated result). Parallel
	 * to `maxSteps`; resolved at setup and frozen onto the plan. Ported from flue's
	 * MAX_FOLLOWUPS. Defaults to 32. See doc 08 §4.10.
	 */
	maxFollowUps?: number;
}

// ─── Agent Config (internal, passed to the harness at runtime) ──────────────

export interface AgentConfig {
	/** Composed at setup from instructions + the resolved skill catalog — no cwd
	 * AGENTS.md/.agents FS walk (replaced by the `skills` catalog table; see D13 and
	 * doc 08 §3 — Skills resolve at the call site). */
	systemPrompt: string;
	/** Agent instructions prepended ahead of resolved skill/workspace context. */
	instructions?: string;
	/** Agent-definition skills merged into the resolved skill catalog. */
	definitionSkills?: Skill[];
	packagedSkills?: Record<string, PackagedSkillDirectory>;
	/** Resolved from the `skills` catalog table at runtime — NOT a cwd
	 * `.agents/skills/` discovery walk (D13). */
	skills: Record<string, Skill>;
	subagents?: Record<string, AgentProfile>;
	/**
	 * Agent-wide default model. Undefined when the user explicitly passes
	 * `createAgent(() => ({ model: false }))`, so each model-using call must
	 * provide a call-site override.
	 */
	model: ModelHandle | undefined;
	/** Resolve model config to a model handle. Throws on invalid model specifiers. */
	resolveModel: (model: ModelConfig | undefined) => ModelHandle | undefined;
	/** Agent-wide default reasoning effort. Per-call values override this. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Compaction tuning. `false` disables threshold compaction (overflow recovery
	 * and explicit `session.compact()` still run). An object overrides individual
	 * fields. Undefined uses defaults.
	 */
	compaction?: false | CompactionConfig;
	/** Durability settings resolved from the agent profile. */
	durability?: DurabilityConfig;
}

/** Model specifier, or `false` to require call-level model selection. */
export type ModelConfig = string | false;

// ─── Agent Profile and Runtime Creation ─────────────────────────────────────

/** Reusable agent behavior accepted by {@link defineAgentProfile}. */

/** The extension factory contract lives in the extension subsystem (pragmatic-refactor Phase 5). */
import type { ExtensionFactory } from "./extensions/types.ts";
export type { ExtensionFactory };

/** An extension reference: a registered extension name, or an inline {@link ExtensionFactory}. */
export type ExtensionSpec = string | ExtensionFactory;

export interface AgentProfile {
	/** Profile name. Required when selecting this profile with `session.task()`. */
	name?: string;
	description?: string;
	/** Default model specifier. Set to `false` to require call-level model selection. */
	model?: ModelConfig;
	/** Instructions prepended to discovered workspace context. */
	instructions?: string;
	/** Registered skills available to sessions initialized from this profile. */
	skills?: Skill[];
	/** Custom model-callable tools available to sessions initialized from this profile. */
	tools?: ToolDefinition[];
	/** Remote MCP servers whose tools are discovered + frozen as model-callable tools (G2.2). */
	mcpServers?: McpServerOptions[];
	/** Named profiles available for delegated `session.task()` operations. */
	subagents?: AgentProfile[];
	/** Extensions (registered names or inline factories) applied to sessions initialized from this profile. */
	extensions?: ExtensionSpec[];
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/**
	 * Automatic conversation-compaction configuration. `false` disables threshold
	 * compaction; overflow recovery and explicit `session.compact()` still run.
	 */
	compaction?: false | CompactionConfig;
	/**
	 * Durability configuration for durable agent submissions. Rejected on subagent
	 * profiles — delegated task sessions run inside the parent operation.
	 */
	durability?: DurabilityConfig;
}

/** Configuration returned by a {@link createAgent} initializer. */
export interface AgentRuntimeConfig {
	/** Reusable baseline profile. Created-agent fields replace or extend profile values. */
	profile?: AgentProfile;
	/** Optional human-facing description of what this agent does. */
	description?: string;
	/** Default model specifier. Set to `false` to require call-level model selection. */
	model?: ModelConfig;
	/** Instructions prepended to discovered workspace context. */
	instructions?: string;
	/** Additional registered skills available to initialized sessions. */
	skills?: Skill[];
	/** Additional custom model-callable tools available to initialized sessions. */
	tools?: ToolDefinition[];
	/** Additional remote MCP servers whose tools are discovered + frozen as model-callable tools (G2.2). */
	mcpServers?: McpServerOptions[];
	/** Additional named profiles available for delegated `session.task()` operations. */
	subagents?: AgentProfile[];
	/** Additional extensions (registered names or inline factories) applied to initialized sessions. */
	extensions?: ExtensionSpec[];
	/** Default reasoning effort. Individual operations may override this value. */
	thinkingLevel?: ThinkingLevel;
	/** Automatic conversation-compaction configuration. */
	compaction?: false | CompactionConfig;
	/** Durability configuration for durable agent submissions. */
	durability?: DurabilityConfig;
	/** Working directory inside the initialized sandbox. */
	cwd?: string;
	/** Sandbox factory used to construct the initialized environment. */
	sandbox?: SandboxFactory;
}

/** Options for {@link CoveContext.init}. */
export interface AgentHarnessOptions {
	/** Harness name. Defaults to `'default'`. */
	name?: string;
	/** Additional custom model-callable tools available to initialized sessions. */
	tools?: ToolDefinition[];
	/** Additional registered skills available to initialized sessions. */
	skills?: Skill[];
	/** Additional named profiles available for delegated `session.task()` operations. */
	subagents?: AgentProfile[];
}

/** Opaque agent initializer created by {@link createAgent}. */
export interface CreatedAgent<TPayload = unknown, TEnv = Record<string, any>> {
	readonly __coveCreatedAgent: true;
	// Method syntax (not arrow-typed property): methods are bivariant under
	// strictFunctionTypes, so payload/env-typed created agents remain assignable
	// to bare `CreatedAgent` positions such as `dispatch()` and `init()`.
	initialize(
		context: AgentCreateContext<TPayload, TEnv>,
	): AgentRuntimeConfig | Promise<AgentRuntimeConfig>;
}

// ─── Cove Context ──────────────────────────────────────────────────────────

/**
 * Execution context passed to workflow handlers and used internally for agent
 * interactions. Pass type parameters to type `payload` and `env`. Compile-time
 * only — no runtime validation of `payload`.
 */
export interface CoveContext<TPayload = unknown, TEnv = Record<string, any>> {
	/** Workflow run/instance id, or stable agent instance id during agent processing. */
	readonly id: string;
	readonly payload: TPayload;
	/** Platform env bindings (process.env on Node, Worker env on Cloudflare). */
	readonly env: TEnv;
	/**
	 * The standard Fetch `Request` for the current invocation, or `undefined` when
	 * invoked outside an HTTP context. Body access is single-use. Durable or
	 * recovered processing may receive a synthetic internal request — authenticate
	 * and capture required transport metadata before durable admission.
	 */
	readonly req: Request | undefined;
	/** Emit observable structured log events, persisted in a run stream during a workflow run. */
	readonly log: CoveLogger;
	/**
	 * Initialize a created agent for this workflow invocation. Each harness name
	 * may be initialized once per context. Defaults to the `'default'` harness.
	 */
	init(agent: CreatedAgent<TPayload, TEnv>, options?: AgentHarnessOptions): Promise<CoveHarness>;
}

export interface CoveLogger {
	info(message: string, attributes?: Record<string, unknown>): void;
	warn(message: string, attributes?: Record<string, unknown>): void;
	error(message: string, attributes?: Record<string, unknown>): void;
}

// ─── Cove Harness (returned by init()) ──────────────────────────────────────

/** Initialized agent environment returned by {@link CoveContext.init}. */
export interface CoveHarness {
	/** Harness name selected by {@link AgentHarnessOptions.name}. */
	readonly name: string;
	/**
	 * Get or create a session in this harness. Defaults to the `'default'`
	 * session. Names beginning with `'task:'` are reserved for delegated tasks.
	 */
	session(name?: string): Promise<CoveSession>;
	/** Explicit session management helpers. */
	readonly sessions: CoveSessions;
	/** Run a shell command in the harness sandbox without recording it in a conversation. */
	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
	/** Read and write files in the harness sandbox without recording them. See {@link CoveFs}. */
	readonly fs: CoveFs;
}

/**
 * Explicit session management helpers exposed by {@link CoveHarness.sessions}.
 * Names beginning with `'task:'` are reserved for delegated tasks.
 */
export interface CoveSessions {
	/** Load an existing session. Defaults to `'default'`. Throws if it does not exist. */
	get(name?: string): Promise<CoveSession>;
	/** Create a new session. Defaults to `'default'`. Throws if it already exists. */
	create(name?: string): Promise<CoveSession>;
	/**
	 * Delete a session's stored conversation state. Defaults to `'default'`. No-op
	 * when missing. Rejects if the open session has an active operation or accepted
	 * durable submissions. Requests for one name are applied in request order.
	 */
	delete(name?: string): Promise<void>;
}

// ─── Cove Session ───────────────────────────────────────────────────────────

/**
 * Awaitable handle returned by `prompt()`, `skill()`, `task()`, and `shell()`.
 * Aborting rejects the awaited value with an `AbortError`. Pass `options.signal`
 * to merge an external `AbortSignal` with the handle's.
 */
export interface CallHandle<T> extends Promise<T> {
	/** Fires when the call is aborted, whether via `abort()` or `options.signal`. */
	readonly signal: AbortSignal;
	/** Cancel the in-flight call. */
	abort(reason?: unknown): void;
}

/** Named conversation state inside a {@link CoveHarness}. */
export interface CoveSession {
	/** Session name. */
	readonly name: string;

	/**
	 * Run a model operation with a text instruction. Pass `options.result` to
	 * require validated structured data instead of freeform text.
	 */
	prompt<S extends v.GenericSchema>(
		text: string,
		options: PromptOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	prompt(text: string, options?: PromptOptions): CallHandle<PromptResponse>;

	/** Run a shell command and record its command exchange in conversation state. */
	shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;

	/** Read and write files in the session's sandbox (not recorded). See {@link CoveFs}. */
	readonly fs: CoveFs;

	/** Run a registered skill. Pass `options.result` to require validated structured data. */
	skill<S extends v.GenericSchema>(
		skill: SkillReference | string,
		options: SkillOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	skill(skill: SkillReference | string, options?: SkillOptions): CallHandle<PromptResponse>;

	/**
	 * Delegate work to a detached child session. Pass `options.agent` to select a
	 * named subagent profile and `options.result` to require validated data.
	 */
	task<S extends v.GenericSchema>(
		text: string,
		options: TaskOptions<S> & { result: S },
	): CallHandle<PromptResultResponse<v.InferOutput<S>>>;
	task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;

	/**
	 * Trigger compaction immediately. Resolves successfully (no-op) when there is
	 * nothing to compact. Rejects when summarization fails or is aborted. Throws if
	 * another operation is in flight on this session.
	 */
	compact(): Promise<void>;

	/**
	 * Delete this session's stored conversation state. Rejects while an operation
	 * or accepted durable submission is active.
	 */
	delete(): Promise<void>;
}

/**
 * Token + cost usage aggregated across every LLM call dispatched by a single
 * prompt(), skill(), or task() invocation (assistant turns, result-extraction
 * retries, compaction summarization, and post-compaction retries).
 */
export interface PromptUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Subset of `cacheWrite` with 1h retention (Anthropic only); preserved for cost fidelity (doc 08 §4.7). */
	cacheWrite1h?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

/** Identifies the model that Cove selected for the call (after call > agent precedence). */
export interface PromptModel {
	provider: string;
	id: string;
}

/** Freeform text response returned by `session.prompt()`, `session.skill()`, and `session.task()`. */
export interface PromptResponse {
	/** Assistant text returned by the operation. */
	text: string;
	/** Aggregated token and cost usage for model work performed by the operation. */
	usage: PromptUsage;
	/** Model selected for the operation's primary turn. */
	model: PromptModel;
}

/** Validated structured response returned when an operation receives `options.result`. */
export interface PromptResultResponse<T> {
	/** Validated structured data inferred from the supplied schema. */
	data: T;
	usage: PromptUsage;
	model: PromptModel;
}

// ─── Session Store ──────────────────────────────────────────────────────────

export interface SessionData {
	/**
	 * Persisted-shape version. Current shape is {@link CURRENT_SESSION_VERSION};
	 * older values are upgraded by the forward-only `migrateSessionData` seam
	 * (session-history.ts) on read. Kept `number` (not a literal) so migrations
	 * can address prior versions.
	 */
	version: number;
	/** Opaque stable provider-facing identity used for prompt caching and routing affinity. */
	affinityKey: string;
	entries: SessionEntry[];
	leafId: string | null;
	/**
	 * Child task sessions created by this session's delegated tasks. Framework
	 * bookkeeping: the recursive deletion cascade uses these references.
	 */
	taskSessions: TaskSessionRef[];
	/** Application-owned session metadata. Cove never reads or writes keys here. */
	metadata: Record<string, any>;
	createdAt: string;
	updatedAt: string;
}

/** Reference from a parent session to a child task session. */
export interface TaskSessionRef {
	/** Child task-session name (`task:<parentSession>:<taskId>`). */
	session: string;
	/** Task id that created the child session. */
	taskId: string;
}

/**
 * An extension-written side-state entry (pragmatic-refactor Phase 5b `appendEntry`). NOT sent to the LLM —
 * `buildContextEntries` only emits `message` entries, so a `custom` entry is recorded for querying/provenance
 * but never enters the model context.
 */
export interface CustomEntry extends SessionEntryBase {
	type: "custom";
	/** Extension-defined sub-type (e.g. "audit-log"). */
	customType: string;
	data?: unknown;
}

export type SessionEntry = MessageEntry | CompactionEntry | CustomEntry;

interface SessionEntryBase {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends SessionEntryBase {
	type: "message";
	message: AgentMessage;
	imageAttachmentIds?: string[];
	dispatch?: DispatchMessageMetadata;
	directSubmissionId?: string;
	submissionTerminal?: SubmissionTerminalMetadata;
}

interface SubmissionTerminalMetadata {
	submissionId: string;
	kind: "dispatch" | "direct";
	reason:
		| "interrupted_before_input_marker"
		| "interrupted_after_input_application"
		| "exhausted_retry_budget"
		| "exceeded_timeout";
}

/**
 * Replay-matching metadata for a dispatched-input entry. The dispatch payload
 * and identity attributes live in the entry's rendered signal message — this
 * carries only the id used to find the entry again.
 */
export interface DispatchMessageMetadata {
	dispatchId: string;
}

export interface CompactionEntry extends SessionEntryBase {
	type: "compaction";
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	/**
	 * Token usage consumed by the summarization call(s) that produced this
	 * compaction. Undefined for compactions persisted before this field existed.
	 */
	usage?: PromptUsage;
}

export interface SessionStore {
	save(id: string, data: SessionData): Promise<void>;
	load(id: string): Promise<SessionData | null>;
	delete(id: string): Promise<void>;
}

// ─── Options ────────────────────────────────────────────────────────────────

/** Option fields shared by `session.prompt()`, `session.skill()`, and `session.task()`. */
interface OperationOptions<S extends v.GenericSchema | undefined = undefined> {
	/** Require validated structured data and resolve with `response.data`. */
	result?: S;
	/** Additional custom model-callable tools for this operation. */
	tools?: ToolDefinition[];
	/** Model specifier override for this operation. */
	model?: string;
	/** Override reasoning effort for this call. */
	thinkingLevel?: ThinkingLevel;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
	/** Images attached to the operation's user message. Requires a vision-capable model. */
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.prompt()` call. */
export interface PromptOptions<S extends v.GenericSchema | undefined = undefined>
	extends OperationOptions<S> {
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.skill()` call. */
export interface SkillOptions<S extends v.GenericSchema | undefined = undefined>
	extends OperationOptions<S> {
	/** Arguments included with the skill instruction. */
	args?: Record<string, unknown>;
	images?: PromptImage[];
}

/** All option fields are scoped to the duration of the `session.task()` call. */
export interface TaskOptions<S extends v.GenericSchema | undefined = undefined>
	extends OperationOptions<S> {
	/** Named subagent profile selected for this delegated task. */
	agent?: string;
	/** Working directory for the detached task session. Defaults to the parent session cwd. */
	cwd?: string;
	images?: PromptImage[];
}

/** Options for `harness.shell()` and `session.shell()`. */
export interface ShellOptions {
	/** Environment variables supplied to the command. */
	env?: Record<string, string>;
	/** Working directory supplied to the command. */
	cwd?: string;
	/** Wall-clock deadline in milliseconds, forwarded to the sandbox adapter. */
	timeoutMs?: number;
	/** Cancel this call. See `CallHandle`. */
	signal?: AbortSignal;
}

/** Result returned by `harness.shell()` and `session.shell()`. */
export interface ShellResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

// ─── Sandbox ────────────────────────────────────────────────────────────────

export interface SessionToolFactoryOptions {
	subagents: Record<string, AgentProfile>;
}

/** Sandbox adapter-supplied model-facing tools. Cove appends `task` separately. */
export type SessionToolFactory = (
	env: SessionEnv,
	options: SessionToolFactoryOptions,
) => AgentTool<any>[];

/** Wraps external sandboxes (Upstash box, Daytona, CF Containers, …) into Cove's SessionEnv. */
export interface SandboxFactory {
	/**
	 * Called once per initialized harness — one call per `init()` — and every
	 * session and task session of that harness shares the returned env. `id` is
	 * the context id (`ctx.id`). Adapters that key provider resources on `id` must
	 * tolerate repeated calls with the same value.
	 */
	createSessionEnv(options: { id: string }): Promise<SessionEnv>;
	/** Replaces the framework default tool list for this sandbox. */
	tools?: SessionToolFactory;
}

/**
 * Structural type for the just-bash `Bash` runtime a {@link BashFactory} returns.
 * Purely structural — no just-bash import, so the runtime stays platform-agnostic.
 */
export interface BashLike {
	exec(
		command: string,
		options?: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal },
	): Promise<ShellResult>;
	getCwd(): string;
	fs: {
		readFile(path: string, options?: any): Promise<string>;
		readFileBuffer(path: string): Promise<Uint8Array>;
		writeFile(path: string, content: string | Uint8Array, options?: any): Promise<void>;
		stat(path: string): Promise<any>;
		readdir(path: string): Promise<string[]>;
		exists(path: string): Promise<boolean>;
		mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
		rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
		resolvePath(base: string, path: string): string;
	};
}

/**
 * Factory that constructs the agent's Bash-like runtime. Called once at init.
 * Pass to `bash()` to obtain the {@link SandboxFactory} that `sandbox` accepts.
 */
export type BashFactory = () => BashLike | Promise<BashLike>;

export type LlmTextContent = {
	type: "text";
	text: string;
	textSignature?: string;
};

export type LlmThinkingContent = {
	type: "thinking";
	thinking: string;
	thinkingSignature?: string;
	redacted?: boolean;
};

export type LlmImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

export type LlmToolCall = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	thoughtSignature?: string;
};

export type LlmUserMessage = {
	role: "user";
	content: string | (LlmTextContent | LlmImageContent)[];
};

export type LlmAssistantMessage = {
	role: "assistant";
	content: (LlmTextContent | LlmThinkingContent | LlmToolCall)[];
};

export type LlmToolResultMessage = {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (LlmTextContent | LlmImageContent)[];
	isError: boolean;
};

export type LlmMessage = LlmUserMessage | LlmAssistantMessage | LlmToolResultMessage;

export type LlmTool = {
	name: string;
	description: string;
	parameters: unknown;
};

export type LlmTurnPurpose = "agent" | "compaction" | "compaction_prefix";

type CoveEventVariant =
	| { type: "run_start"; runId: string; workflowName: string; startedAt: string; payload: unknown }
	| { type: "run_resume"; runId: string; workflowName: string; startedAt: string }
	| { type: "agent_start" }
	| { type: "agent_end"; messages: AgentMessage[] }
	| { type: "turn_start"; turnId: string; purpose: LlmTurnPurpose }
	| {
			type: "turn_request";
			turnId: string;
			purpose: LlmTurnPurpose;
			model: string;
			provider: string;
			api: string;
			input: { systemPrompt?: string; messages: LlmMessage[]; tools?: LlmTool[] };
			reasoning?: string;
	  }
	| {
			type: "turn_messages";
			turnId: string;
			purpose: LlmTurnPurpose;
			message: AgentMessage;
			toolResults: AgentMessage[];
	  }
	| { type: "message_start"; message: AgentMessage; turnId: string }
	| { type: "message_end"; message: AgentMessage; turnId: string }
	| { type: "text_delta"; text: string }
	| { type: "thinking_start" }
	| { type: "thinking_delta"; delta: string }
	| { type: "thinking_end"; content: string }
	| { type: "tool_start"; toolName: string; toolCallId: string; args?: any }
	| {
			type: "tool";
			toolName: string;
			toolCallId: string;
			isError: boolean;
			result?: any;
			durationMs: number;
	  }
	| {
			type: "turn";
			turnId: string;
			purpose: LlmTurnPurpose;
			durationMs: number;
			model?: string;
			provider?: string;
			api?: string;
			output?: LlmAssistantMessage;
			usage?: PromptUsage;
			stopReason?: string;
			isError: boolean;
			error?: unknown;
	  }
	| { type: "task_start"; taskId: string; prompt: string; agent?: string; cwd?: string }
	| { type: "task"; taskId: string; agent?: string; isError: boolean; result?: any; durationMs: number }
	| { type: "compaction_start"; reason: "threshold" | "overflow" | "manual"; estimatedTokens: number }
	| {
			type: "compaction";
			messagesBefore: number;
			messagesAfter: number;
			durationMs: number;
			isError: boolean;
			error?: unknown;
			usage?: PromptUsage;
	  }
	| {
			type: "operation_start";
			operationId: string;
			operationKind: "prompt" | "skill" | "task" | "shell" | "compact" | "workflow";
	  }
	| {
			type: "operation";
			operationId: string;
			operationKind: "prompt" | "skill" | "task" | "shell" | "compact" | "workflow";
			durationMs: number;
			isError: boolean;
			error?: unknown;
			result?: unknown;
			usage?: PromptUsage;
	  }
	| {
			type: "log";
			level: "info" | "warn" | "error";
			message: string;
			attributes?: Record<string, unknown>;
	  }
	| { type: "idle" }
	| {
			/** Reconciliation settled an interrupted durable agent submission. */
			type: "submission_settled";
			submissionId: string;
			outcome: "completed" | "failed";
			error?: string;
	  }
	| { type: "run_end"; runId: string; result?: unknown; isError: boolean; error?: unknown; durationMs: number };

/**
 * Event payload as constructed at an emission site, before runtime decoration.
 * Consumers always receive the decorated {@link CoveEvent}.
 */
export type CoveEventInput = CoveEventVariant & {
	runId?: string;
	instanceId?: string;
	dispatchId?: string;
	submissionId?: string;
	session?: string;
	parentSession?: string;
	taskId?: string;
	harness?: string;
	operationId?: string;
	turnId?: string;
};

/**
 * Observable runtime activity. Workflow events carry `runId`; direct and
 * dispatched agent activity carries `instanceId`. Every delivered event carries
 * the durable event-format version `v`, a per-context `eventIndex`, and a
 * `timestamp`. Events never carry raw image bytes — image content blocks keep
 * their `mimeType` but have `data` replaced with `IMAGE_DATA_OMITTED`.
 */
export type CoveEvent = CoveEventInput & {
	/** Durable event-format version. Readers branch on this when the format changes. */
	v: 1;
	eventIndex: number;
	timestamp: string;
};

/**
 * Live activity from a direct attached-agent interaction. Attached-agent events
 * require `instanceId`, omit workflow lifecycle events, and never carry `runId`.
 */
export type AttachedAgentEvent = Exclude<
	CoveEvent,
	{ type: "run_start" } | { type: "run_resume" } | { type: "run_end" }
> & {
	runId?: never;
	instanceId: string;
};

/** Internal pre-decoration event callback (Session → Harness → context emit chain). */
export type CoveEventInputCallback = (event: CoveEventInput) => void | Promise<void>;

export type CoveEventCallback = (event: CoveEvent) => void | Promise<void>;
export type AttachedAgentEventCallback = (event: AttachedAgentEvent) => void | Promise<void>;
