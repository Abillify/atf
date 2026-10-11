// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH
"use client";

/**
 * Draft↔live view and named drafts of the StudioBuilder (Req 9.3, Task 13.4).
 *
 * Split out of `components/StudioBuilder.tsx`; the code is taken over
 * unchanged, only state and setters are passed through as parameters.
 *
 * The canvas always edits ONE revision at a time. `viewingLive` switches it
 * to the live (published/file) revision; the draft selector picks which
 * named draft to work on. Switching either way stages nothing — only
 * "Save draft" writes, and it writes to the ACTIVE draft.
 */

import {
  useCallback,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type {
  FlowDefinition,
  FlowDraftInfo,
  FlowListEntry,
  FlowValidationReport,
} from "../types/flow";
import {
  flowToGraph,
  graphToFlow,
  type RFEdge,
  type RFNode,
  type ViewportState,
} from "../lib/flow-graph";
import type { useFlowHistory } from "../lib/flow-history";
import type { NodeState } from "../components/graph/graphUtils";
import type { DiffOverlay } from "../lib/flow-diff-view";
import { useConfirm } from "../lib/ui";
import {
  DEFAULT_DRAFT_ID,
  deleteDraftOnBackend,
  saveDraftToBackend,
  snapshotOf,
  type LoadedKind,
} from "../lib/studio-flow-api";
import type { StudioStatusKind } from "./useStudioStatus";

export function useStudioDrafts({
  skipHistoryRef,
  setBase,
  setNodes,
  setEdges,
  setViewport,
  setNodeOrigins,
  setLoadedKind,
  setBaseline,
  rememberPositions,
  history,
  setValidation,
  setLiveStates,
  setDiffOverlay,
  dirty,
  viewingLive,
  setViewingLive,
  drafts,
  setDrafts,
  activeDraftId,
  setActiveDraftId,
  liveDefinition,
  liveKind,
  flow,
  loadFlow,
  currentDefinition,
  token,
  onSaved,
  baseId,
  setStatus,
  setStatusKind,
}: {
  skipHistoryRef: RefObject<boolean>;
  setBase: Dispatch<SetStateAction<FlowDefinition>>;
  setNodes: Dispatch<SetStateAction<RFNode[]>>;
  setEdges: Dispatch<SetStateAction<RFEdge[]>>;
  setViewport: Dispatch<SetStateAction<ViewportState | undefined>>;
  setNodeOrigins: Dispatch<SetStateAction<Record<string, string>>>;
  setLoadedKind: Dispatch<SetStateAction<LoadedKind>>;
  setBaseline: Dispatch<SetStateAction<string | null>>;
  rememberPositions: (ns: RFNode[]) => void;
  history: ReturnType<typeof useFlowHistory>;
  setValidation: Dispatch<SetStateAction<FlowValidationReport | null>>;
  setLiveStates: Dispatch<SetStateAction<Map<string, NodeState> | undefined>>;
  setDiffOverlay: Dispatch<SetStateAction<DiffOverlay | undefined>>;
  dirty: boolean;
  viewingLive: boolean;
  setViewingLive: Dispatch<SetStateAction<boolean>>;
  drafts: FlowDraftInfo[];
  setDrafts: Dispatch<SetStateAction<FlowDraftInfo[]>>;
  activeDraftId: string;
  setActiveDraftId: Dispatch<SetStateAction<string>>;
  liveDefinition: FlowDefinition | null;
  liveKind: LoadedKind | null;
  flow: FlowListEntry | null;
  loadFlow: (flowToLoad: FlowListEntry | null) => void;
  currentDefinition: () => FlowDefinition;
  token: string | undefined;
  onSaved?: (id: string) => void;
  baseId: string;
  setStatus: (msg: string) => void;
  setStatusKind: (kind: StudioStatusKind) => void;
}): {
  showOnCanvas: (definition: FlowDefinition, kind: LoadedKind) => void;
  confirmLeaveDraft: () => Promise<boolean>;
  handleToggleViewLive: () => Promise<void>;
  handleSelectDraft: (draftId: string) => Promise<void>;
  handleCreateDraft: () => Promise<void>;
  handleDeleteDraft: () => Promise<void>;
} {
  // Req 9.5: confirmations/inputs through the dialog primitive instead of window.confirm/prompt.
  const { confirm: confirmDialog, prompt: promptDialog } = useConfirm();

  /** Put a definition on the canvas as the current editing base. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const showOnCanvas = useCallback(
    (definition: FlowDefinition, kind: LoadedKind): void => {
      skipHistoryRef.current = true;
      setBase(definition);
      setLoadedKind(kind);
      const g = flowToGraph(definition);
      setNodes(g.nodes);
      setEdges(g.edges);
      setViewport(g.viewport);
      setNodeOrigins(g.nodeOrigins ?? {});
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
      setValidation(null);
      setLiveStates(undefined);
      setDiffOverlay(undefined);
    },
    // history.reset and rememberPositions are stable (useCallback with no deps),
    // so listing them keeps this callback identity stable too.
    [history.reset, rememberPositions],
  );

  const confirmLeaveDraft = useCallback(async (): Promise<boolean> => {
    return (
      !dirty ||
      (await confirmDialog({
        title: "Unsaved changes",
        message:
          "The canvas has unsaved changes. Switching revisions discards them.",
        confirmLabel: "Discard",
        destructive: true,
      }))
    );
  }, [dirty, confirmDialog]);

  /** Switch the canvas between the active draft and the live revision. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleToggleViewLive = useCallback(async (): Promise<void> => {
    if (!(await confirmLeaveDraft())) return;
    if (viewingLive) {
      // Back to the active draft (in-memory copy, or the stored default).
      const draft =
        drafts.find((d) => d.draftId === activeDraftId)?.definition ?? null;
      if (draft === null) {
        loadFlow(flow);
        return;
      }
      setViewingLive(false);
      showOnCanvas(draft, {
        kind: "draft",
        version: flow?.version ?? 0,
        draftId: activeDraftId,
      });
      return;
    }
    if (liveDefinition === null || liveKind === null) return;
    setViewingLive(true);
    showOnCanvas(liveDefinition, liveKind);
  }, [
    viewingLive,
    drafts,
    activeDraftId,
    liveDefinition,
    liveKind,
    flow,
    loadFlow,
    showOnCanvas,
    confirmLeaveDraft,
  ]);

  /** Switch to another named draft (or create one from the current canvas). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleSelectDraft = useCallback(
    async (draftId: string): Promise<void> => {
      if (draftId === activeDraftId && !viewingLive) return;
      if (!(await confirmLeaveDraft())) return;
      const draft = drafts.find((d) => d.draftId === draftId)?.definition ?? null;
      if (draft === null) return;
      setActiveDraftId(draftId);
      setViewingLive(false);
      showOnCanvas(draft, {
        kind: "draft",
        version: flow?.version ?? 0,
        draftId,
      });
    },
    [activeDraftId, viewingLive, drafts, flow, showOnCanvas, confirmLeaveDraft],
  );

  /** Create a new named draft from the current canvas content. */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleCreateDraft = useCallback(async (): Promise<void> => {
    const input = await promptDialog({
      title: "New draft",
      message: "New draft id (lowercase letters, digits, '-' or '_'):",
      defaultValue: `draft-${Date.now().toString(36)}`,
      confirmLabel: "Create",
    });
    if (input === null) return;
    const draftId = input.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(draftId)) {
      setStatus(
        "✗ Invalid draft id — use lowercase letters, digits, '-' or '_'.",
      );
      setStatusKind("error");
      return;
    }
    if (drafts.some((d) => d.draftId === draftId)) {
      setStatus(`✗ A draft '${draftId}' already exists.`);
      setStatusKind("error");
      return;
    }
    // Seed the new draft with the current canvas (or the live revision when
    // viewing live), so it starts from something meaningful.
    const seed = currentDefinition();
    const result = await saveDraftToBackend(
      token ?? null,
      seed,
      draftId,
      draftId,
    );
    if (!result.ok) {
      setStatus(`✗ Draft not created: ${result.error}`);
      setStatusKind("error");
      return;
    }
    setDrafts((prev) =>
      [
        ...prev.filter((d) => d.draftId !== draftId),
        { draftId, label: draftId, definition: seed },
      ].sort((a, b) =>
        a.draftId === DEFAULT_DRAFT_ID
          ? -1
          : b.draftId === DEFAULT_DRAFT_ID
            ? 1
            : a.draftId.localeCompare(b.draftId),
      ),
    );
    setActiveDraftId(draftId);
    setViewingLive(false);
    setLoadedKind({ kind: "draft", version: result.version ?? 0, draftId });
    setBaseline(snapshotOf(seed));
    setStatus(`Draft '${draftId}' created from the current canvas.`);
    setStatusKind("ok");
    onSaved?.(seed.id);
  }, [currentDefinition, drafts, token, onSaved, promptDialog]);

  /** Remove the active named draft (not the default one). */
  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const handleDeleteDraft = useCallback(async (): Promise<void> => {
    if (activeDraftId === DEFAULT_DRAFT_ID) return;
    if (
      !(await confirmDialog({
        title: "Delete draft",
        message: `Delete draft '${activeDraftId}'? Its canvas content is lost (the live flow is not affected).`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    ) {
      return;
    }
    const result = await deleteDraftOnBackend(
      token ?? null,
      baseId,
      activeDraftId,
    );
    if (!result.ok) {
      setStatus(`✗ Draft not deleted: ${result.error}`);
      setStatusKind("error");
      return;
    }
    const remaining = drafts.filter((d) => d.draftId !== activeDraftId);
    setDrafts(remaining);
    const next =
      remaining.find((d) => d.draftId === DEFAULT_DRAFT_ID) ??
      remaining[0] ??
      null;
    if (next === null || next.definition === undefined) {
      loadFlow(flow);
    } else {
      setActiveDraftId(next.draftId);
      showOnCanvas(next.definition, {
        kind: "draft",
        version: flow?.version ?? 0,
        draftId: next.draftId,
      });
    }
    setStatus(`Draft '${activeDraftId}' deleted.`);
    setStatusKind("info");
    onSaved?.(baseId);
  }, [
    activeDraftId,
    baseId,
    drafts,
    token,
    flow,
    loadFlow,
    showOnCanvas,
    onSaved,
  ]);

  return {
    showOnCanvas,
    confirmLeaveDraft,
    handleToggleViewLive,
    handleSelectDraft,
    handleCreateDraft,
    handleDeleteDraft,
  };
}
