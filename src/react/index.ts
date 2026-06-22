// Ported from flue · @flue/react · packages/react/src/index.ts → @cove/react
// Rebranded barrel. Drops flue's workflow surface (use-workflow/workflow-run — deferred
// to G2.4: no `kind:'workflow'` runs yet). Re-exports the runtime event/usage types so
// consumers do not import from `convex/` or the runtime barrel directly.

export {
	type AgentReducerEvent,
	type AgentSnapshot,
	type AgentState,
	type AgentStatus,
	emptyAgentState,
	reduceAgentEvent,
} from "./agent-reducer.ts";
export { AgentStore, type SendMessageOptions } from "./agent-store.ts";
export {
	type AgentSendOptions,
	type AgentSendResult,
	type CoveEventsListener,
	type CoveReactiveClient,
	type CoveStreamOptions,
	createReactiveClientFromConvex,
} from "./client-types.ts";
export {
	CoveProvider,
	type CoveProviderProps,
	useCoveClient,
	useResolvedCoveClient,
} from "./provider.tsx";
export type { AgentPromptImage, UIMessage, UIMessagePart } from "./ui-types.ts";
export {
	type AgentPromptStatus,
	type SubmitPromptOptions,
	useAgentPrompt,
	type UseAgentPromptOptions,
	type UseAgentPromptResult,
} from "./use-agent-prompt.ts";
export {
	type CoveRunLog,
	type CoveRunStatus,
	useCoveRun,
	type UseCoveRunOptions,
	type UseCoveRunResult,
} from "./use-cove-run.ts";
export {
	useRunEvents,
	type UseRunEventsOptions,
	type UseRunEventsResult,
} from "./use-run-events.ts";

// Re-export the runtime event/usage contract so @cove/react consumers stay decoupled
// from `convex/` and the runtime barrel.
export type { AttachedAgentEvent, CoveEvent, PromptUsage } from "../runtime/types.ts";
