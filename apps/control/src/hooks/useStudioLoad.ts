"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Loading the flow definition in the Studio builder (Req 9.3, Task 13.4):
 * `loadFlow` + auth effect. Split out of `components/StudioBuilder.tsx`;
 * the code is taken over unchanged, only state and setters are passed
 * through as parameters.
 */

import {
  useCallback,
  useEffect,
  type Dispatch,
  type SetStateAction,
} from "react";
import type {
  FlowDefinition,
  FlowDraftInfo,
  FlowListEntry,
  FlowValidationReport,
} from "../types/flow";
import {
  emptyFlow,
  flowToGraph,
  graphToFlow,
  type RFEdge,
  type RFNode,
  type ViewportState,
} from "../lib/flow-graph";
import type { useFlowHistory } from "../lib/flow-history";
import type { NodeState } from "../components/graph/graphUtils";
import type { DiffOverlay } from "../lib/flow-diff-view";
import {
  DEFAULT_DRAFT_ID,
  fetchFlowDefinition,
  snapshotOf,
  type LoadedKind,
} from "../lib/studio-flow-api";
import type { StudioStatusKind } from "./useStudioStatus";

export function useStudioLoad({
  flow,
  token,
  ready,
  isAuthenticated,
  skipHistoryRef,
  setValidation,
  setLiveStates,
  setDiffOverlay,
  setDrafts,
  setLiveDefinition,
  setLiveKind,
  setActiveDraftId,
  setBase,
  setNodes,
  setEdges,
  setViewport,
  setNodeOrigins,
  setBaseHash,
  setLoadedKind,
  setFileFormat,
  setViewingLive,
  setBaseline,
  setIsLoading,
  setStatus,
  setStatusKind,
  rememberPositions,
  history,
}: {
  flow: FlowListEntry | null;
  token: string | null | undefined;
  ready: boolean;
  isAuthenticated: boolean;
  skipHistoryRef: { current: boolean };
  setValidation: Dispatch<SetStateAction<FlowValidationReport | null>>;
  setLiveStates: Dispatch<SetStateAction<Map<string, NodeState> | undefined>>;
  setDiffOverlay: Dispatch<SetStateAction<DiffOverlay | undefined>>;
  setDrafts: Dispatch<SetStateAction<FlowDraftInfo[]>>;
  setLiveDefinition: Dispatch<SetStateAction<FlowDefinition | null>>;
  setLiveKind: Dispatch<SetStateAction<LoadedKind | null>>;
  setActiveDraftId: Dispatch<SetStateAction<string>>;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setViewport: Dispatch<SetStateAction<ViewportState | undefined>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
  setBaseHash: Dispatch<SetStateAction<string | undefined>>;
  setLoadedKind: Dispatch<SetStateAction<LoadedKind>>;
  setFileFormat: Dispatch<SetStateAction<"yaml" | "json">>;
  setViewingLive: Dispatch<SetStateAction<boolean>>;
  setBaseline: Dispatch<SetStateAction<string | null>>;
  setIsLoading: Dispatch<SetStateAction<boolean>>;
  setStatus: (message: string | null) => void;
  setStatusKind: (kind: StudioStatusKind) => void;
  rememberPositions: (ns: RFNode[]) => void;
  history: ReturnType<typeof useFlowHistory>;
}): {
  loadFlow: (flowToLoad: FlowListEntry | null) => void;
} {
  // -------------------------------------------------------------------------
  // Load the flow definition when the selected flow changes (also reused
  // after a version rollback, which changes the file without changing
  // `flow.id` — see FlowVersionBar's `onRolledBack`).
  // -------------------------------------------------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const loadFlow = useCallback(
    (flowToLoad: FlowListEntry | null): void => {
      skipHistoryRef.current = true;
      setValidation(null);
      setLiveStates(undefined);
      setDiffOverlay(undefined);
      setDrafts([]);
      setLiveDefinition(null);
      setLiveKind(null);
      setActiveDraftId(DEFAULT_DRAFT_ID);

      if (!flowToLoad) {
        const empty = emptyFlow("new-flow");
        setBase(empty);
        const g = flowToGraph(empty);
        setNodes(g.nodes);
        setEdges(g.edges);
        setViewport(g.viewport);
        setNodeOrigins(g.nodeOrigins ?? {});
        setBaseHash(undefined);
        setLoadedKind({ kind: "new" });
        setBaseline(
          snapshotOf(
            graphToFlow(
              empty,
              g.nodes,
              g.edges,
              undefined,
              g.nodeOrigins ?? {},
              false,
            ),
          ),
        );
        rememberPositions(g.nodes);
        history.reset({
          nodes: g.nodes,
          edges: g.edges,
          base: empty,
          nodeOrigins: g.nodeOrigins ?? {},
        });
        return;
      }

      setIsLoading(true);
      setStatus(null);

      fetchFlowDefinition(token ?? null, flowToLoad.id)
        .then((result) => {
          if (result) {
            const {
              definition,
              hash,
              kind,
              format,
              published,
              drafts: ds,
              version,
            } = result;
            setBase(definition);
            setLoadedKind(kind);
            setFileFormat(format ?? "yaml");
            setDrafts(ds);
            // The "live" revision the Draft view can be switched to: the
            // published version, or — for a flow that is only live as a file
            // — the file definition currently serving traffic.
            const live =
              published ??
              (kind.kind === "published" || kind.kind === "file"
                ? definition
                : null);
            setLiveDefinition(live);
            setLiveKind(
              published !== null
                ? { kind: "published", version }
                : kind.kind === "file"
                  ? { kind: "file" }
                  : null,
            );
            setActiveDraftId(
              kind.kind === "draft" ? kind.draftId : DEFAULT_DRAFT_ID,
            );
            // A canvas loaded straight from the published revision IS the live
            // view until the operator switches to a draft.
            setViewingLive(kind.kind === "published");
            const g = flowToGraph(definition);
            setNodes(g.nodes);
            setEdges(g.edges);
            setViewport(g.viewport);
            setNodeOrigins(g.nodeOrigins ?? {});
            setBaseHash(hash);
            setBaseline(
              snapshotOf(
                graphToFlow(
                  definition,
                  g.nodes,
                  g.edges,
                  undefined,
                  g.nodeOrigins ?? {},
                  definition.metadata?.ui !== undefined,
                ),
              ),
            );
            rememberPositions(g.nodes);
            history.reset({
              nodes: g.nodes,
              edges: g.edges,
              base: definition,
              nodeOrigins: g.nodeOrigins ?? {},
            });
          } else {
            const empty = emptyFlow(flowToLoad.id);
            setBase(empty);
            const g = flowToGraph(empty);
            setNodes(g.nodes);
            setEdges(g.edges);
            setViewport(g.viewport);
            setNodeOrigins(g.nodeOrigins ?? {});
            setBaseHash(undefined);
            setLoadedKind({ kind: "new" });
            setBaseline(
              snapshotOf(
                graphToFlow(
                  empty,
                  g.nodes,
                  g.edges,
                  undefined,
                  g.nodeOrigins ?? {},
                  false,
                ),
              ),
            );
            rememberPositions(g.nodes);
            history.reset({
              nodes: g.nodes,
              edges: g.edges,
              base: empty,
              nodeOrigins: g.nodeOrigins ?? {},
            });
            setStatus("Could not load flow — starting with empty canvas.");
            setStatusKind("warn");
          }
          setIsLoading(false);
        })
        .catch(() => {
          setIsLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  useEffect(() => {
    // Defer loading until auth discovery is done — avoids a redundant
    // unauthenticated fetch followed immediately by an authenticated one when
    // the token hydrates. Gate on isAuthenticated rather than the token: with
    // AUTHN_MODE=disabled there never is a token and the flow must still load.
    if (flow && !(ready && isAuthenticated)) return;
    loadFlow(flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id, ready, isAuthenticated]);

  return { loadFlow };
}
