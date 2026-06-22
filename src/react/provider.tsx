// Ported from flue · @flue/react · packages/react/src/provider.ts → @cove/react
// Rename + reseat. flue's `Flue*` → cove's `Cove*`. flue resolved a `FlueClient`
// (HTTP/DS); cove resolves a `CoveReactiveClient` either from an explicit prop OR by
// building one off the ambient `ConvexReactClient` via `useConvex()` (convex/react).
// `[cove]`-prefixed throws (flue threw bare strings). `.tsx` (createElement/JSX).

import { type ConvexReactClient, useConvex } from "convex/react";
import { createContext, createElement, type ReactNode, useContext, useMemo } from "react";
import type { CoveReactiveClient } from "./client-types.ts";
import { createReactiveClientFromConvex } from "./client-types.ts";

const CoveContext = createContext<CoveReactiveClient | undefined>(undefined);

export interface CoveProviderProps {
	/** Explicit reactive client. When omitted, one is built off the ambient ConvexReactClient. */
	client: CoveReactiveClient;
	children?: ReactNode;
}

export function CoveProvider({ client, children }: CoveProviderProps) {
	return createElement(CoveContext.Provider, { value: client }, children);
}

/**
 * The reactive client from an enclosing `CoveProvider`. Throws when none is present —
 * use {@link useResolvedCoveClient} when you also want to fall back to the ambient
 * `ConvexReactClient`.
 */
export function useCoveClient(): CoveReactiveClient {
	const client = useContext(CoveContext);
	if (!client) throw new Error("[cove] useCoveClient() requires a <CoveProvider>");
	return client;
}

/**
 * Resolve a {@link CoveReactiveClient}: prefer an explicit `override`, then a
 * `CoveProvider`-provided client, then build one off the ambient `ConvexReactClient`
 * obtained via `useConvex()`. Throws a `[cove]`-prefixed error when none is available.
 */
export function useResolvedCoveClient(override?: CoveReactiveClient): CoveReactiveClient {
	const provided = useContext(CoveContext);
	// `useConvex()` returns the ambient ConvexReactClient or null (never throws).
	const convex = useConvex() as ConvexReactClient | null | undefined;
	return useMemo(() => {
		const explicit = override ?? provided;
		if (explicit) return explicit;
		if (convex) return createReactiveClientFromConvex(convex);
		throw new Error(
			"[cove] Cove hooks require a client option, a <CoveProvider>, or an ambient <ConvexProvider>",
		);
	}, [override, provided, convex]);
}
