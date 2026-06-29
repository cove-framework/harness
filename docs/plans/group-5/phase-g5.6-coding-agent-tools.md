# Phase G5.6 — Coding-agent tool depth

> Bring Cove's **built-in** framework tools up to pi's bar: a multi-edit core (disjoint edits against
> the original file, BOM/CRLF preservation, optional unified patch), an image-read branch off the
> sandbox, richer grep params, and bash full-output spillover to a box file. Every item extends the
> existing builtins in [frameworkTools.ts](../../../convex/engine/frameworkTools.ts) — they are
> registered in `createFrameworkTools` and rebuilt by `createFrameworkTool` (kind `"builtin"`), **not**
> an example agent. The ported logic is pure/V8-safe string work bound to `SessionEnv`; the box-ness
> stays behind the `"use node"` dispatch action, so journal-replay determinism is untouched.
> Design-of-record: [04 — Durable Engine](../../design/04-durable-engine.md) (§4.1 replay, §4.2
> deadline), [08 — Conventions & Execution Boundary](../../design/08-conventions-and-execution-boundary.md)
> (the tool/box seam), [07 — Risks & Decisions](../../design/07-risks-and-decisions.md) (R5 ephemeral
> handle). We deliberately **skip pi's host-only / process-global bits** — binary auto-download
> (`ensureTool`) and detached-pid tracking (`trackDetachedChildPid`) — which are replay-hostile and
> sandbox-irrelevant.

## Goal & scope

Each item below is a **mini-spec** (what · where · why-native · effort · risk · acceptance), anchored
to the exact call sites verified against the real files. **In scope:** the pure, deterministic V8-safe
parts of pi's edit/read/grep/bash tools that fit Cove's `EngineTool`/`EngineToolResult` contract
([types.ts:47-64](../../../convex/engine/types.ts)) and flow through the already-built durable path
(`createFrameworkTool` reconstruction, the `dispatchTools` action, the canonical content mappers).
**Out of scope (the thesis boundary):** anything host-bound or process-global — pi's `ensureTool`
binary auto-download ([grep.ts:172](#) / [find.ts:214](#)) and `trackDetachedChildPid`
([bash.ts:86](#)) both reach for host state Cove deliberately delegates to the `@upstash/box` sandbox;
pi's TUI-only `renderDiff`/`renderCall` machinery (no Cove consumer exists yet); and pi's
fuzzy-match layer (changes match semantics beyond "exact text"). New tools are avoided where an
existing builtin already covers the surface (no separate `ls`/`find`). **Sequencing:** all four are
additive and land in any order after G5.3.

## Dependencies

| Item | Needs | Notes |
| --- | --- | --- |
| G5.3 | the framework-tools / `buildTools` reconstruction contract settled | every item edits `frameworkTools.ts`, reconstructed by `createFrameworkTool` ([buildTools.ts:74](../../../convex/engine/buildTools.ts)) |
| A | the `EngineTool`/`EngineToolResult` shape (exists) | `details` is `unknown`/optional ([types.ts:49](../../../convex/engine/types.ts)); pure string core, no new global state |
| A (optional patch) | a vetted `diff` dependency | `diff` is **not** currently a Cove dep (no `node_modules/diff`, absent from `package.json`); pure JS, V8-safe, but new |
| B | `SessionEnv.readFileBuffer` (exists) + the durable image path (exists) | [types.ts:160](../../../src/runtime/types.ts); `engineContentToCanonical` already maps image blocks ([entries.ts:118-131](../../../convex/engine/entries.ts)) |
| B (optional resize) | a resizer inside the `"use node"` dispatch action | runs box-side, gated so a missing resizer degrades to a text note |
| C | the existing `createGrepTool` / `createGlobTool` (exist) | thin JSON-Schema param additions; no new tool name |
| D | `truncateTail`'s `wasTruncated` surfaced through `formatShellOutput` | flag is computed but discarded at the call site ([bash-output.ts:21](../../../src/runtime/bash-output.ts)) |

---

## A — Multi-edit core: disjoint `edits[]` against the original, BOM/CRLF preservation

**What.** Today `createEditTool` supports only a single `oldText`/`newText` + `replaceAll`
([frameworkTools.ts:157-200](../../../convex/engine/frameworkTools.ts)). Port pi's edit core: an
`edits[]` array of **disjoint** `{oldText, newText}` each matched against the **original** file
(non-incremental), with overlap / duplicate / not-found / no-change errors; BOM strip + CRLF
detect/restore so a CRLF file round-trips without spurious diffs; and a `prepareEditArguments`
tolerance layer that accepts the legacy single-edit shape and a JSON-string `edits`. Keep
`replaceAll`.

**Where.** Replace the body of [frameworkTools.ts:157-200](../../../convex/engine/frameworkTools.ts)
(`createEditTool`) and extend `EditParams` at
[frameworkTools.ts:145-155](../../../convex/engine/frameworkTools.ts) with an optional `edits` array
(keep `additionalProperties:false`, JSON-Schema not TypeBox, consistent with the existing shape).
It stays a `"builtin"` registered in `createFrameworkTools`
([frameworkTools.ts:31-38](../../../convex/engine/frameworkTools.ts)) and reconstructed by
`createFrameworkTool` ([frameworkTools.ts:46-63](../../../convex/engine/frameworkTools.ts),
[buildTools.ts:74](../../../convex/engine/buildTools.ts)). Source to port (pi): `prepareEditArguments`
([edit.ts:94](#)), the BOM/CRLF execute path ([edit.ts:340-346](#)
`stripBom`→`detectLineEnding`→`restoreLineEndings`), and the diff core — `stripBom`
([edit-diff.ts:137](#)), `detectLineEnding` ([edit-diff.ts:11](#)), `normalizeToLF`
([edit-diff.ts:19](#)), `restoreLineEndings` ([edit-diff.ts:23](#)),
`applyEditsToNormalizedContent` + overlap detection ([edit-diff.ts:193](#)), and (optional)
`generateUnifiedPatch` ([edit-diff.ts:263](#), which imports npm `diff`).

**Why native / why it fits.** The core is pure, deterministic, V8-safe string manipulation with no
global mutable state — re-running the same transform on the same input yields the same output, so
journal replay is unaffected. It introduces no competing loop/durability engine and the AI SDK is not
involved; it slots straight into the existing `EngineTool` contract
([types.ts:47-64](../../../convex/engine/types.ts)). **Multi-edit reduces round-trips** (fewer decode
beats per logical change) and **CRLF/BOM preservation avoids spurious diffs**. The candidate's "lives
in an example coding agent" framing is **wrong** — this is Cove's own builtin. **The unified-patch /
display-diff in `details` is `(optional)` and deferred:** there is no `details` column in
[schema.ts](../../../convex/schema.ts) and no TUI renderer equivalent to pi's `renderDiff`/`renderCall`
(TUI-only, out of scope), so the patch would be carried but largely unconsumed until a consumer
exists — and it pulls in the new `diff` dependency. Ship the patch only once a consumer lands. Skip
pi's fuzzy-match layer.

**Effort** M + **Risk** med — the edit core is mechanical to port, but overlap/disjoint semantics and
the BOM/CRLF round-trip have sharp edges; the `edits`-as-JSON-string / legacy-shape tolerance must not
loosen `additionalProperties:false`.

**Acceptance.** A two-element `edits[]` whose ranges are disjoint applies both against the original
content in one write; overlapping or duplicate `oldText` ranges, a not-found `oldText`, and a
no-op edit each return a precise error and write nothing; a CRLF file with a BOM round-trips with its
line endings and BOM intact (no spurious whole-file diff); a legacy single `oldText`/`newText` call
and an `edits` sent as a JSON string both normalize through `prepareEditArguments`; `replaceAll` still
works. Replay-stable: the same args re-applied on replay re-derive byte-identical output (pure
transform over the persisted file + journaled args). The patch/diff field stays absent until a
consumer + the `diff` dep are vetted.

---

## B — `read`: sandbox image branch + first-line-exceeds fallback

**What.** `createReadTool` has the line-offset continuation hint but is text-only — no image branch
([frameworkTools.ts:78-109](../../../convex/engine/frameworkTools.ts)). Add: stat/MIME-detect the
path, and for a supported image MIME read the bytes via `env.readFileBuffer()` and emit
`[{type:"text", …note}, {type:"image", data:base64, mimeType}]`. Separately, fix the real gap in
`truncateHead`: a first line that exceeds `MAX_READ_BYTES` returns an **empty** body
([frameworkTools.ts:444-466](../../../convex/engine/frameworkTools.ts)) — add pi's
`[Line N is X, exceeds limit. Use bash: sed -n 'Np' …]` fallback so the model gets a usable hint.

**Where.** Image branch slots into `createReadTool`
([frameworkTools.ts:78-109](../../../convex/engine/frameworkTools.ts)); the `EngineToolContentImage`
block already exists in the result type ([types.ts:39-43](../../../convex/engine/types.ts)) and is
consumed unchanged by `engineContentToCanonical`
([entries.ts:118-131](../../../convex/engine/entries.ts)) and the toolResult image persistence
([images.ts:159-168](../../../convex/sessions/images.ts)). `SessionEnv.readFileBuffer` already exists
([types.ts:160](../../../src/runtime/types.ts)). Any `<=2000px` resize runs **inside** the
`"use node"` dispatch action (box-bound side, [dispatchTools.ts:128](../../../convex/engine/dispatchTools.ts)
`run = internalAction`), **not** the pure V8 layer. The truncation fallback lives in `truncateHead` /
`formatReadContent` ([frameworkTools.ts:407-428,444-466](../../../convex/engine/frameworkTools.ts)).
Source to port (pi): the image branch + `firstLineExceedsLimit` sed fallback
([read.ts:192,243-326,301](#)).

**Why native / why it fits.** Pure app-level tool logic. The image block flows through the
**already-built** durable path (`engineContentToCanonical` → image persistence → `_storage`), so no
durable state leaves Convex and replay determinism is unaffected (the box read + resize already live
behind the existing dispatch-action seam). No competing loop/engine; the AI SDK stays at the model
boundary — image bytes are carried as Cove's own content blocks. **DROP pi's "warn when model lacks
vision" sub-feature:** Cove already strips toolResult images for non-vision models in
`downgradeUnsupportedImages` ([messages.ts:60-82](../../../convex/providers/messages.ts), gated at
[messages.ts:61](../../../convex/providers/messages.ts), toolResult downgrade at
[messages.ts:73-77](../../../convex/providers/messages.ts)), so the warning is redundant and would
double-handle.

**Effort** M + **Risk** low — additive content block + a gated resizer; the durable path is already
wired, the only new surface is the box-side stat/MIME/read and the optional resize.

**Acceptance.** A read of a supported image returns a text note plus an image content block that
persists through the existing path (image chunk in `_storage`, not inline); a missing/failed resizer
degrades to the un-resized image (or a text note) without crashing; a non-vision model still receives
the existing placeholder downgrade (unchanged); a read whose first line exceeds `MAX_READ_BYTES`
returns the `sed -n` hint instead of an empty body. Replay-stable: the persisted image block
reconstructs identically (it folds through the same canonical mappers on replay).

---

## C — Richer grep params (gitignore-aware, context lines, ignoreCase)

**What.** `createGrepTool` exposes only `pattern`/`path`/`include`/`literal`
([frameworkTools.ts:260-270](../../../convex/engine/frameworkTools.ts)). Add three high-leverage,
additive params: `.gitignore`-awareness (rg's default; for the `grep` fallback approximate by
excluding `.git`/`node_modules`), `context` lines (rg `-C` / grep `-C`), and `ignoreCase` (rg `-i` /
grep `-i`).

**Where.** Extend `GrepParams` ([frameworkTools.ts:260-270](../../../convex/engine/frameworkTools.ts))
and thread the flags into the rg / grep command builders inside `createGrepTool`
([frameworkTools.ts:288-332](../../../convex/engine/frameworkTools.ts), rg branch :303-306, grep
fallback :307-311). The backend probe (`rg`→`grep`) is already cached per-env
([frameworkTools.ts:272-286](../../../convex/engine/frameworkTools.ts)). Source (pi):
`ignoreCase`/`context`/`--hidden` ([grep.ts:28,32,188](#)). **DROP the dedicated `ls`/`find` tools** —
`read` on a directory already lists entries
([frameworkTools.ts:92-99](../../../convex/engine/frameworkTools.ts)) and `createGlobTool` already does
filename matching ([frameworkTools.ts:346-366](../../../convex/engine/frameworkTools.ts)); if
gitignore-awareness is wanted for file discovery, fold it into `createGlobTool` rather than add a
name. **Explicitly exclude** pi's `ensureTool('rg')` host binary auto-download ([grep.ts:172](#)).

**Why native / why it fits.** Out-of-band sandbox tools: the header
([frameworkTools.ts:13-14](../../../convex/engine/frameworkTools.ts)) states these are pure/V8-safe
bindings to `SessionEnv` with no box/AI-SDK/Convex import; `exec` runs in the `@upstash/box` sandbox
via the dispatch action. The new params are JSON Schema for the **model view only** — no `execute` is
attached to AI-SDK tools, no durable state leaves Convex, no journal-replay impact. Because we reuse
the existing `grep` name, `FRAMEWORK_TOOL_NAMES`
([frameworkTools.ts:42](../../../convex/engine/frameworkTools.ts)) and the `buildTools` reconstruction
([buildTools.ts:74](../../../convex/engine/buildTools.ts)) are unchanged. Net: a thin params PR, not a
new tool family.

**Effort** M + **Risk** low — additive flags; the only subtlety is the `grep`-fallback approximation of
gitignore (exclusion globs) versus rg's native behavior. (optional — `realValue` low.)

**Acceptance.** `ignoreCase:true` matches case-insensitively on both backends; `context:2` returns two
surrounding lines per match; the rg backend honors `.gitignore` by default and the grep fallback
excludes `.git`/`node_modules`; existing `pattern`/`path`/`include`/`literal` behavior is unchanged;
no new tool name appears in `FRAMEWORK_TOOL_NAMES`; reconstruction via `createFrameworkTool` still
yields a working `grep`. Replay-stable: the same args re-build the same command string (no live state).

---

## D — Bash full-output spillover to a box file with a path footer

**What.** Bash output is truncated to the tail ([frameworkTools.ts:214-256](../../../convex/engine/frameworkTools.ts)
via `formatShellOutput`); pi additionally spills the **full** output to a file and appends a
`[Full output: <path>]` footer so the model can read more on demand. Add the spillover to
`createBashTool`, writing into the **box** (not the host tmpdir).

**Where.** `createBashTool` / `formatBashResult`
([frameworkTools.ts:214-256](../../../convex/engine/frameworkTools.ts)). The required threading:
`truncateTail` already computes `wasTruncated`
([bash-output.ts:29-41](../../../src/runtime/bash-output.ts)) but `formatShellOutput` **discards** it
at the destructure ([bash-output.ts:21](../../../src/runtime/bash-output.ts)) — surface that flag so
the spill happens **only on actual truncation**. `formatShellOutput` has a second caller in the shell
tool-event envelope ([shell.ts:52](../../../src/runtime/shell.ts)), so any signature change must stay
back-compatible. Write the full output via `env.writeFile`
([types.ts:162](../../../src/runtime/types.ts)) to a **box-resolvable** path the `read` tool can later
fetch (the `read` tool routes through `env`). Source (pi): the footer
([bash.ts:248,363-367](#)); the spill itself in pi writes to the **host** tmpdir — Cove must instead
write through `env.writeFile`. **Do NOT port** pi's process-global `trackDetachedChildPid`
([bash.ts:86](#)).

**Why native / why it fits.** Tool dispatch runs out-of-band in an internal action
([dispatchTools.ts:128](../../../convex/engine/dispatchTools.ts) `run = internalAction`), tool results
are journaled, and already-resulted calls are **skipped on replay**
([dispatchTools.ts:133-141](../../../convex/engine/dispatchTools.ts)). The spill write lives in the
action and runs once; the footer string is captured in the journaled tool result, so replay
determinism is preserved (replay re-reads the recorded result, it does not re-run `exec`). It
relocates no durable state out of Convex (the box already owns the filesystem), adds no competing
loop/engine, and the AI SDK is untouched. The candidate correctly excludes `trackDetachedChildPid`
(process-global, replay-hostile). **Bounded value:** `env.exec` returns fully-buffered output
([types.ts:139-157](../../../src/runtime/types.ts)), so there is no streaming/memory-pressure
justification as in pi — the only gain is letting the model read beyond the 2000-line / 50KB tail.
Temp-file **cleanup** is unspecified in pi and left out of scope here.

**Effort** S + **Risk** low — surface one already-computed flag and one conditional write; the only
care is the back-compatible `formatShellOutput` signature and a box-resolvable (not host) path.

**Acceptance.** A bash command whose output exceeds the tail limit writes the full combined output to a
box path and appends a `[Full output: <box-path>]` footer; that path is readable by the `read` tool
(routes through `env`); a non-truncated command writes no spill file and appends no footer; the
`shell.ts` envelope caller still compiles and behaves unchanged. Replay-stable: on replay the journaled
result (footer included) is re-read without re-executing — the spill is a one-time action side effect,
not a replayed step.

---

## Risks & gotchas (cross-item)

- **Thesis boundary — builtins, not an example agent.** All four edit `frameworkTools.ts` and are
  reconstructed by `createFrameworkTool` ([buildTools.ts:74](../../../convex/engine/buildTools.ts)).
  The candidate's "lives in an example coding agent" framing (item A) is wrong; do not relocate any of
  this into a sample agent.
- **A — `details` patch is unconsumed today.** There is no `details` column in
  [schema.ts](../../../convex/schema.ts) and no Cove renderer for pi's `renderDiff`/`renderCall`. Carry
  the unified patch only after a consumer exists, and only after vetting the new `diff` dependency
  (absent from `package.json` / `node_modules`). Until then ship the edit **core** without the patch.
- **A — purity is the replay guarantee.** `applyEditsToNormalizedContent`, `stripBom`,
  `detectLineEnding`, `normalizeToLF`, `restoreLineEndings`, overlap detection must stay pure (no
  globals, no `Date.now`, no process state). Disjoint edits must match against the **original** content,
  not incrementally — incremental matching would make output order-dependent and break determinism.
- **B / D — box-resolvable paths only.** The image resize (B) and the full-output spill (D) must run in
  the `"use node"` dispatch action ([dispatchTools.ts:128](../../../convex/engine/dispatchTools.ts)) and
  write through `env` — **never** the host tmpdir (pi's mistake). A host path is not reachable by the
  `read` tool and is invisible to the box/journal.
- **B — don't double-handle non-vision.** The vision downgrade is already centralized in
  `downgradeUnsupportedImages` ([messages.ts:60-82](../../../convex/providers/messages.ts)); the read
  tool must **not** add its own warning text.
- **D — surface `wasTruncated`, keep the signature back-compatible.** `formatShellOutput` is shared with
  [shell.ts:52](../../../src/runtime/shell.ts); thread the discarded
  [bash-output.ts:21](../../../src/runtime/bash-output.ts) flag without breaking that caller, and spill
  only when it is true.
- **Cross-item — skip the host-only / process-global pieces.** Binary auto-download (`ensureTool`,
  pi grep.ts:172 / find.ts:214) and detached-pid tracking (`trackDetachedChildPid`, pi bash.ts:86) are
  replay-hostile / sandbox-irrelevant and are explicitly excluded. The `@upstash/box` sandbox owns
  process lifecycle and binary availability.
