# Tools, Skills & Human-in-the-Loop

A Cove run is a model loop with a tool roster. This page covers the three things that shape that roster and gate it:

1. **Built-in framework tools** — the six file/shell tools (`read`, `write`, `edit`, `bash`, `grep`, `glob`) the model can call inside any run. You don't register them; the engine bakes them in.
2. **Skills** — host-supplied `SKILL.md` documents you import into a catalog. When the catalog has active skills, the engine synthesizes an `activate_skill` tool so the model can load a skill's full instructions on demand.
3. **Human-in-the-loop (HITL) approvals** — mark tools as gated via `approvalTools` at submit time, then resolve parked calls with `listPending` → `submitApproval`.

For *custom* tools you author in an agent definition (`ToolDefinition`), see [Defining Agents](02-defining-agents.md). For how runs are submitted and watched, see [Invoking Agents](03-invoking-agents.md).

---

## Built-in framework tools

Every run gets six tools constructed by `createFrameworkTools(env)` in `convex/engine/frameworkTools.ts`. They are model-facing — the **model** calls them with JSON args during a run; you do not call them from your code and you do not register them. The engine freezes their `name`/`description`/`parameters` into the session plan at step 0 (`convex/engine/setup.ts` `run`), with `kind: "builtin"`.

The names are fixed:

```ts
// convex/engine/frameworkTools.ts
export const FRAMEWORK_TOOL_NAMES = ["read", "write", "edit", "bash", "grep", "glob"] as const;
```

`createFrameworkTools(env)` returns all six bound to a `SessionEnv` (the fs/exec abstraction); `createFrameworkTool(name, env)` reconstructs one by name (returns `undefined` for an unknown name). Both bind to `env` — but at plan time `setup.ts` calls `createFrameworkTools(stubEnv)` with an empty stub, because reading `name`/`description`/`parameters` never touches `env`; the real env-bound executable is rebound per dispatch action.

### What each tool does

These are the JSON args the model emits. Knowing the exact shapes and limits helps you write agent instructions and reason about behavior.

| Tool | Args | Behavior & limits |
| --- | --- | --- |
| `read` | `{ path, offset?, limit? }` | Reads a file **or** lists a directory. If `path` is a directory, returns entries joined by newlines. For files, output is truncated to **2000 lines or 50KB** (`MAX_READ_LINES=2000`, `MAX_READ_BYTES=51200`) — use `offset` (1-indexed start line) / `limit` for large files. An `offset` past EOF throws. |
| `write` | `{ path, content }` | Writes `content` to a file; creates the file and any missing parent directories. Returns `"Successfully wrote N bytes to <path>"`. |
| `edit` | `{ path, oldText, newText, replaceAll? }` | Exact-text replacement. `oldText` must be non-empty. Without `replaceAll`, `oldText` must match **exactly once**: 0 matches throws `"Could not find the exact text"`, >1 throws `"Found N occurrences"` (asking for more context or `replaceAll`). With `replaceAll`, replaces all (throws if none). |
| `bash` | `{ command, timeout? }` | Runs a shell command. **`timeout` is in SECONDS**, not milliseconds (model-facing convention; converted to ms internally). Default when omitted is `DEFAULT_BASH_TIMEOUT_SEC = 30`. Output truncated to the last 2000 lines / 50KB. |
| `grep` | `{ pattern, path?, include?, literal? }` | Searches file contents (regex `pattern`; `path` defaults to `.`; `include` is a glob like `"*.ts"`). Backend is auto-detected per env (ripgrep if `rg --version` succeeds, else `grep`). `literal: true` => fixed-strings. Caps at `MAX_GREP_MATCHES=100`, each line at `MAX_GREP_LINE_LENGTH=500` chars. |
| `glob` | `{ pattern, path? }` | Finds files via shell `find <path> -type f -name <pattern>` (filename glob, not full-path; `path` defaults to `.`). Capped at `MAX_GLOB_RESULTS=1000`. |

> **`bash` timeout is seconds, and a timeout is not an error.** A timed-out command returns a *recoverable* result with `exitCode 124` and stderr `"[cove] Command timed out after <n> seconds."` — the loop sees it as a normal (failed) tool result, not a thrown exception. Only a genuine host abort rethrows. Tell agents this so they retry with a larger `timeout` rather than giving up.

> **`edit` is strict by design.** Single-match-or-throw is what makes edits safe to replay. If your agent edits ambiguous text, instruct it to include surrounding context or pass `replaceAll: true`.

Beyond these six built-ins, `setup.ts` always appends a `task` tool (`kind: "task"`, for subagent delegation — see [Subagents & Workflows](06-subagents-and-workflows.md)), conditionally appends `activate_skill` (`kind: "skill"`, only when the catalog has active skills — next section), and conditionally appends result tools (`kind: "result"`, only when the request carries a result schema — see [Invoking Agents](03-invoking-agents.md#typed-results-with-optionsresult)).

---

## Skills

A **skill** is a `SKILL.md` document — YAML frontmatter plus a markdown body of instructions — that the model can load on demand mid-run. In Cove, skills live in a **Convex catalog table**, not on a filesystem. You `importSkill` the raw text; the engine resolves skills only from that catalog (never a sandbox FS walk).

### The `SKILL.md` frontmatter format

The file is YAML frontmatter between a leading `---` and a closing `---`, then the markdown body:

```md
---
name: review-pr
description: Review a pull request diff for correctness bugs and risky changes.
license: MIT
compatibility: Works against git repos with a checked-out PR branch.
allowed-tools: read grep bash
metadata:
  author: platform-team
  version: "1.0"
---

# Reviewing a PR

When asked to review a PR:

1. Run `git diff` to read the change.
2. Look for correctness bugs, missing error handling, and risky edits.
3. Summarize findings grouped by severity.
```

Parsing is done by `parseSkillMarkdown(content, { directoryName, path })` in `src/runtime/skill-frontmatter.ts`. The rules (all enforced):

- **`name`** (required, non-empty string). NFKC-normalized; max **64 chars**; only lowercase Unicode letters/numbers/hyphens (`^[\p{L}\p{N}-]+$`); no leading/trailing hyphen; no consecutive hyphens (`--`). It **must equal the directory/slug name** — `importSkill` passes `directoryName: slug`, so `slug` must equal the frontmatter `name`, or import throws.
- **`description`** (required, non-empty string, max **1024 chars**). This is what the model sees in the skill catalog — write it so the model knows *when* to activate the skill.
- **`license`** (optional string).
- **`compatibility`** (optional string, max **500 chars**).
- **`allowed-tools`** (optional) — a **single whitespace-delimited string** (e.g. `read grep bash`), **not** a YAML list. It is split on whitespace into `string[]` and stored as the skill's `requiredTools`.
- **`metadata`** (optional string→string mapping; a null value becomes `""`).

> **Frontmatter scalars stay strings.** It's parsed with js-yaml `FAILSAFE_SCHEMA`, so `version: 1.0` is the string `"1.0"`, not the number `1`. Quote values you care about. Unknown frontmatter fields are silently ignored (not rejected). Missing or non-mapping frontmatter throws.

The body — everything after the closing `---`, trimmed — becomes the skill's `instructions`.

### Importing a skill

`importSkill` is a Convex **mutation** in `convex/skills.ts`:

```ts
importSkill({ slug: string, content: string }): Promise<{ slug: string; changed: boolean }>
```

`content` is the raw `SKILL.md` text. `slug` **must equal** the frontmatter `name` (validation throws otherwise). It computes an FNV-1a content hash and upserts a row keyed by `slug`; `references` is always `[]`, `requiredTools` comes from `allowed-tools`, `instructions` is the body, and `isActive` is set to `true`.

It is idempotent: re-importing identical content returns `{ changed: false }` — **but only if the existing row is also active**. Re-importing previously deactivated content reactivates it and returns `{ changed: true }`.

Drive it from the CLI (per the repo's [deployment notes](08-deployment-and-operations.md), invoke the bundled Convex binary directly):

```bash
# After deploy (node node_modules/convex/bin/main.js dev --once):
node node_modules/convex/bin/main.js run skills:importSkill \
  '{"slug":"review-pr","content":"---\nname: review-pr\ndescription: Review a pull request diff.\n---\n\n# Reviewing a PR\n..."}'
```

Or from a Convex client (`ConvexHttpClient` / `ConvexReactClient`):

```ts
await client.mutation(api.skills.importSkill, {
  slug: "review-pr",
  content: skillMarkdownText, // the raw SKILL.md string
});
```

### Managing the catalog

| Function | Kind | Signature | Purpose |
| --- | --- | --- | --- |
| `importSkill` | mutation | `{ slug, content }` → `{ slug, changed }` | Import/re-import; idempotent on content hash. |
| `listSkills` | query | `{}` → `{ slug, name, description }[]` | The **active** catalog (rendered into the system prompt and the `activate_skill` enum). |
| `getSkill` | query | `{ name }` → full row \| `null` | Fetch one active skill's full `instructions` + `requiredTools`. The arg is named `name` but matches the **slug** (they're the same value). Returns `null` if missing or inactive. |
| `deactivateSkill` | mutation | `{ slug }` → `void` | Soft-delete (`isActive=false`). No-op if `slug` is unknown. Keeps history; hides it from resolution. |

```ts
const active = await client.query(api.skills.listSkills, {});
// -> [{ slug: "review-pr", name: "review-pr", description: "Review a pull request diff." }]

const skill = await client.query(api.skills.getSkill, { name: "review-pr" });
// -> { slug, name, description, instructions, requiredTools } | null

await client.mutation(api.skills.deactivateSkill, { slug: "review-pr" });
```

### How `activate_skill` surfaces skills to the model

You do not add `activate_skill` to any agent. At step 0, `setup.ts` queries the `skills` table by the `by_isActive` index, and **only when at least one active skill exists** it synthesizes the tool into the frozen plan (`kind: "skill"`):

```ts
// convex/engine/setup.ts (synthesized into the plan, abbreviated)
tools.push({
  name: "activate_skill",
  description:
    "Load the full instructions for one available skill before performing work that matches its description.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", enum: activeSkills.map((s) => s.slug), description: "The skill to activate." },
    },
    required: ["name"],
    additionalProperties: false,
  },
  kind: "skill",
});
```

Two things happen when the catalog is non-empty:

1. The `activate_skill` tool is added, with its `name` property's **`enum` set to the active skill slugs** — the model can only activate a skill that's actually in the catalog.
2. A `## Available Skills` section is appended to the system prompt, listing `- <slug>: <description>` for each active skill, so the model knows what's available and when to reach for it.

At runtime the model calls `activate_skill({ name: "<slug>" })`; the engine resolves it from the catalog (a Convex query in dispatch — `getSkill`), not a filesystem walk, and feeds the skill's `instructions` back into the conversation.

> **With an empty (or fully deactivated) catalog, there is no `activate_skill` tool and no `## Available Skills` prompt section.** Skills are entirely opt-in: nothing is loaded until you import at least one.

> **Not yet wired: `session.skill()`.** The SDK facade exposes `session.skill(...)`, but in this cut it rejects with a `not_implemented` `CoveError` (deferred to P10). The catalog + `activate_skill` path described here is the supported way to use skills today; the model activates them itself during a run.

---

## Human-in-the-loop approvals

HITL lets a human approve (or reject, or edit) specific tool calls before they execute. The lifecycle, in `convex/engine/approvals.ts`:

1. **Gate the run** — when you submit, pass `approvalTools: string[]` (the tool names that require approval). `setup.ts` freezes this into `plan.approvalTools`.
2. **The loop parks gated calls** — when the model calls a gated tool, the loop writes a pending `approvals` row (internal `park` mutation) and waits on a durable workflow event instead of executing.
3. **Your UI lists pending calls** — subscribe to the `listPending({ requestId })` query to render approval cards.
4. **A human decides** — call the `submitApproval` mutation per call. It records the decision and sends the durable wake event that resumes the parked run.

There is **no per-tool `requiresApproval` flag** — gating is driven entirely by `request.approvalTools` set at submit time.

### Step 1 — gate the run via `approvalTools`

`approvalTools` is accepted by `submitPrompt` (`api.invoke.submit.submitPrompt`) and the dev entry `startPrompt` (`api.dev.startPrompt`):

```ts
// Gate write, edit, and bash so a human approves every file mutation / shell command.
const admit = await client.mutation(api.invoke.submit.submitPrompt, {
  prompt: "Refactor utils.ts and run the tests.",
  model: "anthropic/claude-sonnet-4-5",
  instanceId: "ci",
  sessionName: "default",
  approvalTools: ["write", "edit", "bash"],
});
// admit -> { sessionId, requestId, submissionId, workflowId }
```

> `submitPrompt` **always supersedes** any in-flight request on the same `(instanceId, harnessName, sessionName)` session. For a non-superseding driver (e.g. local testing), use `api.dev.startPrompt`, which also accepts `approvalTools` and works with the free deterministic model `cove-test/mock`.

### Step 2 — list pending approvals

`listPending` is a public **query**, so a UI can subscribe reactively (`useQuery(api.engine.approvals.listPending, { requestId })`):

```ts
listPending({ requestId: Id<"agentRequests"> })
  : Promise<Array<{ toolCallId: string; toolName: string; args: any }>>
```

```ts
const pending = await client.query(api.engine.approvals.listPending, {
  requestId: admit.requestId,
});
// -> [{ toolCallId: "call_abc", toolName: "bash", args: { command: "rm -rf build" } }]
```

Each entry carries the `toolCallId` (the key you resolve), the `toolName`, and the exact `args` the model proposed — everything an approval card needs.

### Step 3 — approve, reject, or edit

`submitApproval` is a public **mutation**:

```ts
submitApproval({
  requestId: Id<"agentRequests">,
  toolCallId: string,
  approved: boolean,
  editedArgs?: any,
  reason?: string,
  decidedBy?: string,
}): Promise<{ ok: true }>
```

```ts
// Approve as-is:
await client.mutation(api.engine.approvals.submitApproval, {
  requestId: admit.requestId,
  toolCallId: "call_abc",
  approved: true,
  decidedBy: "alice@example.com",
});

// Reject with a reason (the loop writes an error tool-result so dispatch skips the call):
await client.mutation(api.engine.approvals.submitApproval, {
  requestId: admit.requestId,
  toolCallId: "call_abc",
  approved: false,
  reason: "Too destructive — don't delete the build dir.",
  decidedBy: "alice@example.com",
});

// Approve but edit the args (the edited args run instead of the proposed ones):
await client.mutation(api.engine.approvals.submitApproval, {
  requestId: admit.requestId,
  toolCallId: "call_abc",
  approved: true,
  editedArgs: { command: "rm -rf build/tmp" },
  decidedBy: "alice@example.com",
});
```

`submitApproval` is **idempotent and fail-loud**:

- Throws `"[cove] approval not found."` if there is no approval row for `(requestId, toolCallId)`.
- Throws `"[cove] approval has already been resolved."` if the approval's status is not `pending` — a double-submit **cannot** flip an already-resolved decision.

On success it patches the row to `approved`/`rejected`, records `{ approved, editedArgs, reason }` plus `decidedBy`, then — **only if `request.convexWorkflowId` is set** — sends a durable workflow event named `approval:<requestId>:<toolCallId>` (the same string `approvalEventName(requestId, toolCallId)` returns) to wake the parked run.

> **`editedArgs` are NOT validated by `submitApproval`.** They are re-validated by the tool's normal execute-time validation when the loop dispatches the approved call — so a bad edit surfaces as a tool error at dispatch, not at approval time.

> **The wake event is durable/queued.** A `submitApproval` that arrives *before* the loop parks the call is not lost; the parked run picks it up when it awaits the event.

### Worked example: end-to-end gated run

Driving the deterministic test model so this is reproducible without credentials:

```ts
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const client = new ConvexHttpClient(process.env.CONVEX_URL!);

// 1. Submit a gated run. `bash` requires approval before it executes.
const admit = await client.mutation(api.invoke.submit.submitPrompt, {
  prompt: "Clean the build directory.",
  model: "anthropic/claude-sonnet-4-5",
  instanceId: "ops",
  sessionName: "default",
  approvalTools: ["bash"],
});

// 2. Poll listPending until the model proposes a gated call.
let pending: Array<{ toolCallId: string; toolName: string; args: any }> = [];
while (pending.length === 0) {
  // In a UI, prefer useQuery(api.engine.approvals.listPending, { requestId })
  // for reactive updates instead of a poll loop.
  pending = await client.query(api.engine.approvals.listPending, {
    requestId: admit.requestId,
  });
  if (pending.length === 0) await new Promise((r) => setTimeout(r, 400));
}

// 3. A human reviews each card and decides.
for (const call of pending) {
  const dangerous = String(call.args?.command ?? "").includes("rm -rf");
  await client.mutation(api.engine.approvals.submitApproval, {
    requestId: admit.requestId,
    toolCallId: call.toolCallId,
    approved: !dangerous,
    reason: dangerous ? "Refusing rm -rf." : undefined,
    decidedBy: "ops-oncall",
  });
}

// 4. The run resumes. Read the terminal snapshot.
const snapshot = await client.query(api.requests.get, { requestId: admit.requestId });
// { status, finalText, result, error, usage, ... } — see Invoking Agents.
```

For watching the run to completion (reactive query vs. HTTP `?wait=result` long-poll), see [Invoking Agents](03-invoking-agents.md).

---

## API quick reference

| Function | File | Kind | Signature |
| --- | --- | --- | --- |
| `createFrameworkTools` | `convex/engine/frameworkTools.ts` | fn | `(env: SessionEnv) => EngineTool[]` |
| `createFrameworkTool` | `convex/engine/frameworkTools.ts` | fn | `(name: string, env: SessionEnv) => EngineTool \| undefined` |
| `FRAMEWORK_TOOL_NAMES` | `convex/engine/frameworkTools.ts` | const | `["read","write","edit","bash","grep","glob"]` |
| `parseSkillMarkdown` | `src/runtime/skill-frontmatter.ts` | fn | `(content, { directoryName, path }) => ParsedSkillMarkdown` |
| `importSkill` | `convex/skills.ts` | mutation | `{ slug, content }` → `{ slug, changed }` |
| `listSkills` | `convex/skills.ts` | query | `{}` → `{ slug, name, description }[]` |
| `getSkill` | `convex/skills.ts` | query | `{ name }` → full row \| `null` |
| `deactivateSkill` | `convex/skills.ts` | mutation | `{ slug }` → `void` |
| `submitPrompt` (`approvalTools` arg) | `convex/invoke/submit.ts` | mutation | `{ prompt, model?, instanceId?, harnessName?, sessionName?, resultSchema?, approvalTools? }` → `AdmitResult` |
| `listPending` | `convex/engine/approvals.ts` | query | `{ requestId }` → `{ toolCallId, toolName, args }[]` |
| `submitApproval` | `convex/engine/approvals.ts` | mutation | `{ requestId, toolCallId, approved, editedArgs?, reason?, decidedBy? }` → `{ ok: true }` |
| `approvalEventName` | `convex/engine/approvals.ts` | fn | `(requestId, toolCallId) => string` |

> The `park` and `applyApproval` mutations in `convex/engine/approvals.ts` are **internal** — the durable loop calls them. You only ever touch `listPending` and `submitApproval`.

---

**Next:** [Sessions & Compaction](05-sessions-and-compaction.md) covers multi-turn continuity and context management; [Subagents & Workflows](06-subagents-and-workflows.md) covers the `task` tool and code-orchestrated runs.
