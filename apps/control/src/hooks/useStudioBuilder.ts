"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Composition hook of the Studio builder (Req 9.3, Task 13.4): holds all
 * state and logic that previously lived directly in
 * `components/StudioBuilder.tsx`, taken over unchanged. The component is
 * thus limited to props and JSX; the loading, history and Copilot aspects
 * live in `useStudioLoad`, `useStudioHistory` and `useStudioCopilot`,
 * which are called here.
 */

import type React from "react";
import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { EdgeSelection } from "../components/NodePropertyPanel";
import type { NodeState } from "../components/graph/graphUtils";
import type { DiffOverlay } from "../lib/flow-diff-view";
import {
  graphToFlow,
  emptyFlow,
  type RFNode,
  type RFEdge,
  type ViewportState,
} from "../lib/flow-graph";
import type { BoundaryCardInfo } from "../components/FlowCanvas";
import { useFlowHistory } from "../lib/flow-history";
import { useStudioStatus } from "./useStudioStatus";
import { useStudioShortcuts } from "./useStudioShortcuts";
import { useStudioValidation } from "./useStudioValidation";
import { useStudioRunTrace } from "./useStudioRunTrace";
import { useStudioNodeCrud } from "./useStudioNodeCrud";
import { useStudioSelection } from "./useStudioSelection";
import { useStudioBulkActions } from "./useStudioBulkActions";
import { useStudioSubflows } from "./useStudioSubflows";
import { useStudioAutoLayout } from "./useStudioAutoLayout";
import { useStudioSave } from "./useStudioSave";
import { useStudioDrafts } from "./useStudioDrafts";
import { useStudioPinnedRun } from "./useStudioPinnedRun";
// Loading, history and Copilot focus in their own hooks.
import { useStudioLoad } from "./useStudioLoad";
import { useStudioHistory } from "./useStudioHistory";
import { useStudioCopilot } from "./useStudioCopilot";
import type {
  FlowDefinition,
  FlowDraftInfo,
  FlowListEntry,
  FlowValidationReport,
} from "../types/flow";
import { useAuth } from "../lib/auth/useAuth";
import { DEFAULT_DRAFT_ID, snapshotOf, type LoadedKind } from "../lib/studio-flow-api";
import type { PlaygroundResult } from "../lib/studio-run";
import { useNodeTypeCatalog } from "../lib/node-types";
import type { EdgeFlowRecord } from "../lib/run-samples";
import { latestFlowsByPair, pairKey } from "../lib/edge-channels";
import { useSubflowHistory } from "../lib/subflow-history";
import { usePersistentWidth } from "./usePersistentWidth";
import {
  END_ID,
  parseBoundaryEdgeId,
  REQUEST_EVENT_ID,
  RESPONSE_EVENT_ID,
  flowBoundaries,
  START_ID,
  withEntryFirst,
} from "../lib/flow-boundaries";
import { answerText } from "../lib/run-attach";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudioBuilderProps {
  /** Currently selected flow (from the flow list). Null for a new unsaved flow. */
  flow: FlowListEntry | null;
  /** Called when the builder saves successfully — parent may refresh the flow list. */
  onSaved?: (flowId: string) => void;
  /** Backend has a FlowStore (FLOW_EDITOR_ENABLED + DATABASE_URL): drafts/publish available. */
  onlineEditing?: boolean;
  /** Backend accepts file writes into FLOWS_DIR (POST /flows/write). */
  fileWriting?: boolean;
  /** Reports whether the canvas holds unsaved changes (for switch/leave guards). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Panel visibility, owned by the page so all layout switches live in one place. */
  panels?: StudioBuilderPanels;
  /** Switches Copilot / Run & Trace from the builder toolbar (next to Undo/Redo). */
  onTogglePanel?: (panel: "copilot" | "runTrace") => void;
  /**
   * DOM node the node palette is portalled into — the Studio sidebar's
   * "Nodes" section. `null` = the host shows no palette right now (section
   * collapsed); `undefined` = render it inline left of the canvas, the
   * classic layout (used when no sidebar hosts the palette).
   */
  paletteContainer?: HTMLElement | null;
  /**
   * DOM node the sub-flow palette is portalled into — the Studio sidebar's
   * own "Subflows" section. `null` = the host shows it nowhere right now
   * (another section is expanded); `undefined` = render it inside the node
   * palette, the classic layout (used when no sidebar hosts it).
   */
  subflowsContainer?: HTMLElement | null;
  /** Stores a Run & Trace prompt/answer as an eval case. */
  /**
   * Stores prompt + answer as an eval case with `expected` as the reference
   * answer. Rejects with a readable message when it could not be stored.
   */
  /** Resolves with the created eval case's id (when the backend returns one). */
  onSaveEvalCase?: (prompt: string, flowId: string, result: PlaygroundResult, expected: string) => Promise<string | undefined>;
  onDeleteEvalCase?: (id: string) => Promise<void>;
  /**
   * The node being inspected (single selection) and the settings field in
   * focus — the page shows that node type's documentation. Null when no
   * single node is selected.
   */
  onInspect?: (info: { nodeId: string; type: string; field?: string } | null) => void;
  /** Recorded execution to show in Run & Trace (a request opened from the Live Graph). */
  attachExecutionId?: string;
  /** Run & Trace moved on from the attached execution. */
  onDetachExecution?: () => void;
  /** Receives a getter for the canvas definition (source form), for page-level checks. */
  canvasDefinitionRef?: React.MutableRefObject<(() => FlowDefinition) | null>;
}

export interface StudioBuilderPanels {
  /** Full palette (false = icon rail). */
  palette: boolean;
  /** Node/edge properties panel. */
  properties: boolean;
  /** Copilot bar above the canvas. */
  copilot: boolean;
  /** Run & Trace bar above the canvas. */
  runTrace: boolean;
}

const ALL_PANELS: StudioBuilderPanels = {
  palette: true,
  properties: true,
  copilot: true,
  runTrace: true,
};

export function useStudioBuilder({
  flow,
  onSaved,
  onlineEditing = false,
  fileWriting = false,
  onDirtyChange,
  panels = ALL_PANELS,
  onTogglePanel,
  paletteContainer,
  subflowsContainer,
  onSaveEvalCase,
  onDeleteEvalCase,
  onInspect,
  attachExecutionId,
  onDetachExecution,
  canvasDefinitionRef,
}: StudioBuilderProps) {
  const { token, ready, isAuthenticated } = useAuth();

  const [base, setBase] = useState<FlowDefinition>(() =>
    flow ? emptyFlow(flow.id) : emptyFlow("new-flow"),
  );
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [viewport, setViewport] = useState<ViewportState | undefined>(
    undefined,
  );
  const [selNode, setSelNode] = useState<string | null>(null);
  /** Start or End selected on the canvas (not flow nodes, see lib/flow-boundaries). */
  const [selBoundary, setSelBoundary] = useState<"start" | "end" | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  /**
   * The sub-flow whose group is selected AS A WHOLE (via a click on its box
   * label/border), driving the sub-flow action panel. Set only by
   * `selectSubflowGroup`; cleared by any ordinary node/edge/pane selection.
   */
  const [selectedSubflowPath, setSelectedSubflowPath] = useState<string | null>(
    null,
  );
  /**
   * The properties panel only appears while something is selected. Flow
   * settings (id, name, description, variables) are the exception: with
   * nothing selected, the toolbar's "Flow settings" button opens the panel
   * for them.
   */
  const [flowSettingsOpen, setFlowSettingsOpen] = useState(false);
  // Req 9.3: the status line lives in a reducer hook (useStudioStatus).
  const { status, setStatus, statusKind, setStatusKind } = useStudioStatus();
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined);
  const [fileFormat, setFileFormat] = useState<"yaml" | "json">("yaml");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [validation, setValidation] = useState<FlowValidationReport | null>(
    null,
  );
  const [liveStates, setLiveStates] = useState<
    Map<string, NodeState> | undefined
  >(undefined);
  /** Execution of the run traced in Run & Trace (the Start panel shows its input). */
  const [runExecutionId, setRunExecutionId] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [diffOverlay, setDiffOverlay] = useState<DiffOverlay | undefined>(
    undefined,
  );
  const [copilotPrefill, setCopilotPrefill] = useState<
    { instruction: string; nonce: number } | undefined
  >(undefined);
  /** Node id -> relative sub-flow file path (`$includeOrigins`, Phase 4). Only
   * populated for flows composed via `metadata.$include.subflows` — see
   * `src/graph/flow-parser/normalize.ts`. Empty for every other flow. */
  const [nodeOrigins, setNodeOrigins] = useState<Record<string, string>>({});
  const [subflowName, setSubflowName] = useState("");
  const [loadedKind, setLoadedKind] = useState<LoadedKind>({ kind: "new" });
  /** Snapshot of the last loaded/saved definition (null until the first load). */
  const [baseline, setBaseline] = useState<string | null>(null);
  /** All named drafts of the loaded flow (default first), with definitions. */
  const [drafts, setDrafts] = useState<FlowDraftInfo[]>([]);
  /** The live revision (published, or the file itself) for the Draft↔Live switch. */
  const [liveDefinition, setLiveDefinition] = useState<FlowDefinition | null>(
    null,
  );
  /** Which kind the live revision is (file vs published + version). */
  const [liveKind, setLiveKind] = useState<LoadedKind | null>(null);
  /** The draft the Draft view works on — target of save/publish. */
  const [activeDraftId, setActiveDraftId] = useState<string>(DEFAULT_DRAFT_ID);
  /** True while the canvas shows the LIVE revision instead of a draft. */
  const [viewingLive, setViewingLive] = useState(false);
  const paletteCollapsed = !panels.palette;
  const inspectorCollapsed = !panels.properties;
  /** Property panel width, drag-resizable via the handle on its left edge. */
  const [inspectorWidth, setInspectorWidth] = usePersistentWidth(
    "studio.inspectorWidth",
    320,
    240,
    640,
  );
  const copilotHidden = !panels.copilot;
  const runTraceHidden = !panels.runTrace;

  const history = useFlowHistory({ nodes: [], edges: [] });
  /** Per-sub-flow undo/redo + saved-baseline, scoped to one `$include` group. */
  const subflowHistory = useSubflowHistory();
  /** Positions as loaded — to tell whether the operator actually moved nodes. */
  const loadedPositionsRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const rememberPositions = useCallback((ns: RFNode[]): void => {
    loadedPositionsRef.current = new Map(ns.map((n) => [n.id, n.position]));
  }, []);
  const skipHistoryRef = useRef(false);

  /**
   * Stable canvas key — updated only when the operator explicitly switches to
   * a different flow (flow?.id changes). Using base.id directly as a key
   * caused unwanted remounts whenever `base` was replaced mid-lifecycle
   * (e.g. after a loadFlow async fetch resolves), which manifested as multiple
   * simultaneous panel instances in Concurrent Mode builds.
   */
  const canvasKeyRef = useRef(flow?.id ?? "new-flow");
  const prevFlowIdRef = useRef(flow?.id ?? null);
  if (flow?.id !== prevFlowIdRef.current) {
    prevFlowIdRef.current = flow?.id ?? null;
    canvasKeyRef.current = flow?.id ?? "new-flow";
  }
  const canvasKey = canvasKeyRef.current;

  // -------------------------------------------------------------------------
  // Load the flow definition when the selected flow changes (also reused
  // after a version rollback, which changes the file without changing
  // `flow.id` — see FlowVersionBar's `onRolledBack`).
  // LoadFlow + auth effect split out to
  // hooks/useStudioLoad.
  // -------------------------------------------------------------------------
  const { loadFlow } = useStudioLoad({
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
  });

  // Persist the canvas layout only when the flow already stores one or the
  // operator moved/added nodes; otherwise saving must not add a `metadata.ui`
  // block to a file that never had one.
  const includeLayout = useMemo(() => {
    if (base.metadata?.ui !== undefined) return true;
    const loaded = loadedPositionsRef.current;
    return nodes.some((n) => {
      const p = loaded.get(n.id);
      return p === undefined || p.x !== n.position.x || p.y !== n.position.y;
    });
  }, [base.metadata, nodes]);

  const currentDefinition = useCallback(
    (): FlowDefinition =>
      graphToFlow(base, nodes, edges, viewport, nodeOrigins, includeLayout),
    [base, nodes, edges, viewport, nodeOrigins, includeLayout],
  );
  useEffect(() => {
    if (!canvasDefinitionRef) return;
    canvasDefinitionRef.current = currentDefinition;
    return () => {
      canvasDefinitionRef.current = null;
    };
  }, [canvasDefinitionRef, currentDefinition]);

  // -------------------------------------------------------------------------
  // Dirty tracking — compared against the snapshot taken after load/save.
  // -------------------------------------------------------------------------
  const snapshot = useMemo(
    () =>
      snapshotOf(
        graphToFlow(base, nodes, edges, undefined, nodeOrigins, includeLayout),
      ),
    [base, nodes, edges, nodeOrigins, includeLayout],
  );
  const dirty = baseline !== null && snapshot !== baseline;

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // -------------------------------------------------------------------------
  // Copilot accept, field focus/selection and Copilot focus (Req 9.3: split
  // out to hooks/useStudioCopilot).
  // -------------------------------------------------------------------------
  const {
    handleCopilotAccept,
    selectedFlowNode,
    setFocusedField,
    setFieldSelection,
    handlePanelSelect,
    copilotFocus,
  } = useStudioCopilot({
    nodes,
    edges,
    selNode,
    selEdge,
    selectedNodeIds,
    diffOverlay,
    setBase,
    setNodes,
    setEdges,
    setNodeOrigins,
    onInspect,
  });

  // -------------------------------------------------------------------------
  // Undo/redo history — debounced so a drag gesture or a burst of edits
  // becomes one history entry (Req 9.3: split out to
  // hooks/useStudioHistory).
  // -------------------------------------------------------------------------
  const { handleUndo, handleRedo } = useStudioHistory({
    skipHistoryRef,
    nodes,
    edges,
    base,
    nodeOrigins,
    history,
    setNodes,
    setEdges,
    setBase,
    setNodeOrigins,
  });

  // -------------------------------------------------------------------------
  // Inline validation — debounced dry-run against POST /flows/validate
  // (Req 9.3: split out to hooks/useStudioValidation).
  // -------------------------------------------------------------------------
  const {
    nodeValidation,
    edgeValidation,
    otherWarnings,
    unknownToolsByServer,
    totalErrors,
    totalWarnings,
  } = useStudioValidation({
    base,
    nodes,
    edges,
    viewport,
    token,
    validation,
    setValidation,
  });

  // -------------------------------------------------------------------------
  // Node CRUD (Req 9.3: split out to hooks/useStudioNodeCrud).
  // -------------------------------------------------------------------------
  const {
    addNodeAt,
    updateNode,
    removeNodes,
    deleteNode,
    renameNode,
    updateEdge,
    deleteEdge,
  } = useStudioNodeCrud({
    nodes,
    nodeOrigins,
    setNodes,
    setEdges,
    setNodeOrigins,
    setBase,
    setSelNode,
    setSelEdge,
    setSelectedNodeIds,
    loadedPositionsRef,
    setStatus,
    setStatusKind,
  });

  // -------------------------------------------------------------------------
  // Selection (Req 9.3: split out to hooks/useStudioSelection).
  // -------------------------------------------------------------------------
  const { handleSelectionChange, groupSelectionRef } = useStudioSelection({
    setSelNode,
    setSelEdge,
    setSelectedNodeIds,
    setSelectedSubflowPath,
  });

  // -------------------------------------------------------------------------
  // Bulk actions (Req 9.3: split out to hooks/useStudioBulkActions).
  // -------------------------------------------------------------------------
  const {
    handleBulkDelete,
    handleDuplicateSelected,
    handleCopySelected,
    handlePaste,
    handleSelectAll,
  } = useStudioBulkActions({
    removeNodes,
    selectedNodeIds,
    setNodes,
    setSelNode,
    setSelectedNodeIds,
  });

  // -------------------------------------------------------------------------
  // Sub-flows (Req 9.3: split out to hooks/useStudioSubflows).
  // -------------------------------------------------------------------------
  const {
    handleExtractSubflow,
    setNodeOrigin,
    includeSubflow,
    createSubflow,
    selectSubflowGroup,
    handleDeleteSubflow,
    handleSaveSubflow,
    handleUndoSubflow,
    handleRedoSubflow,
    handleResetSubflow,
  } = useStudioSubflows({
    base,
    nodes,
    edges,
    nodeOrigins,
    token,
    subflowHistory,
    skipHistoryRef,
    groupSelectionRef,
    setNodes,
    setEdges,
    setNodeOrigins,
    setBase,
    setSelNode,
    setSelEdge,
    setSelectedNodeIds,
    setSelectedSubflowPath,
    setStatus,
    setStatusKind,
  });

  // -------------------------------------------------------------------------
  // Auto-layout (Req 9.3: split out to hooks/useStudioAutoLayout).
  // -------------------------------------------------------------------------
  const { fitViewNonce, setFitViewNonce, handleAutoLayout, referenceEdges } =
    useStudioAutoLayout({
      nodes,
      edges,
      nodeOrigins,
      selectedNodeIds,
      setNodes,
    });

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (Req 9.3: split out to hooks/useStudioShortcuts).
  // The rootRef marks the builder area in which the shortcuts apply.
  // -------------------------------------------------------------------------
  const rootRef = useStudioShortcuts({
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleSelectAll,
    handleCopySelected,
    handlePaste,
    handleBulkDelete,
    selectedNodeIds,
    selEdge,
    deleteEdge,
  });

  // -------------------------------------------------------------------------
  // Save/Publish (Req 9.3: split out to hooks/useStudioSave).
  // -------------------------------------------------------------------------
  const {
    handleSave,
    handleForceOverwrite,
    handleSaveDraft,
    handlePublish,
    handleDiscard,
  } = useStudioSave({
    currentDefinition,
    token,
    baseHash,
    fileFormat,
    onSaved,
    setIsSaving,
    setStatus,
    setStatusKind,
    setBaseHash,
    setBaseline,
    setValidation,
    setProblemsOpen,
    activeDraftId,
    drafts,
    setDrafts,
    setLoadedKind,
    setViewingLive,
    setLiveDefinition,
    setLiveKind,
    flow,
    loadFlow,
    dirty,
    loadedKind,
  });

  // -------------------------------------------------------------------------
  // Draft ↔ Live view + named drafts (Req 9.3: split out to
  // hooks/useStudioDrafts).
  // -------------------------------------------------------------------------
  const {
    handleToggleViewLive,
    handleSelectDraft,
    handleCreateDraft,
    handleDeleteDraft,
  } = useStudioDrafts({
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
    baseId: base.id,
    setStatus,
    setStatusKind,
  });

  const catalog = useNodeTypeCatalog();
  // Req 9.3: pinned run and formula evaluation split out to hooks/useStudioPinnedRun;
  // pinFlowId stays here because it also drives the pin UI.
  const pinFlowId = flow?.id ?? "";
  const { pinnedRun, pinRun, evaluateVariables, runsCtx } = useStudioPinnedRun({
    flowId: pinFlowId,
    token,
  });
  // What the formula editors offer: the flow as it is on the canvas.
  const formulaFlow = useMemo(
    () => ({
      nodes: nodes.map((n) => n.data.flowNode),
      variables: base.variables,
    }),
    [nodes, base.variables],
  );
  const nodeIdList = useMemo(() => nodes.map((n) => n.id), [nodes]);

  // Start / End: the entry and exits as the compiler sees them, and what the
  // cards show — the traced run first, else the pinned one.
  const boundaries = useMemo(
    () =>
      flowBoundaries(
        nodes.map((n) => {
          const fn = n.data.flowNode;
          return {
            id: fn.id,
            type: fn.type,
            parallelNodes: fn.parallelNodes,
            config: fn.config,
          };
        }),
        edges.map((e) => ({
          source: e.source,
          target: e.target,
          conditions: e.data?.conditions,
        })),
      ),
    [nodes, edges],
  );
  const boundaryCards = useMemo(() => {
    const req = liveStates?.get(REQUEST_EVENT_ID);
    const res = liveStates?.get(RESPONSE_EVENT_ID);
    const pinnedQuery = pinnedRun
      ? String(pinnedRun.sample["query"] ?? "")
      : "";
    const start: BoundaryCardInfo = {
      ...(req?.status ? { status: req.status } : {}),
    };
    const startText =
      req?.user_prompt ??
      req?.prompt ??
      (pinnedQuery ? `📌 ${pinnedQuery}` : undefined);
    if (startText) start.summary = startText;
    const end: BoundaryCardInfo = {
      ...(res?.status ? { status: res.status } : {}),
    };
    const endText =
      res?.response !== undefined
        ? answerText(res.response)
        : pinnedRun?.response !== undefined
          ? `📌 ${pinnedRun.response}`
          : undefined;
    if (endText) end.summary = endText;
    return { start, end };
  }, [liveStates, pinnedRun]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: React setters and refs are stable as parameters; dependencies deliberately omitted as in the original monolith, without behavior change (Req 9.3)
  const setEntry = useCallback((id: string) => {
    setNodes((ns) => withEntryFirst(ns, id));
    setStatus(
      `“${id}” is now the entry — moved to the front of the flow (Cmd/Ctrl+Z to undo).`,
    );
    setStatusKind("info");
  }, []);

  const selectNodeById = useCallback((id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setSelNode(id);
    setSelEdge(null);
    setSelBoundary(null);
  }, []);

  // A tool chip on the canvas: select its node and open the node's tool settings.
  const [toolFocus, setToolFocus] = useState<{
    nodeId: string;
    tool: string;
    nonce: number;
  } | null>(null);
  const handleToolClick = useCallback(
    (nodeId: string, tool: string) => {
      selectNodeById(nodeId);
      setSelectedSubflowPath(null);
      setToolFocus((prev) => ({ nodeId, tool, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [selectNodeById],
  );

  /** Anything the properties panel can edit: a node, edge, boundary or sub-flow group. */
  const hasInspectorSelection =
    selectedNodeIds.length > 0 ||
    selEdge !== null ||
    selBoundary !== null ||
    selectedSubflowPath !== null;
  // A real selection takes the panel over — drop the flow-settings pin so
  // deselecting later hides the panel again.
  useEffect(() => {
    if (hasInspectorSelection) setFlowSettingsOpen(false);
  }, [hasInspectorSelection]);

  // Req 9.3: edge flows of the tracked run (finish trace + live polling)
  // leben in hooks/useStudioRunTrace.
  const { edgeFlows, handleRunFinished } = useStudioRunTrace({
    runExecutionId,
    token,
  });

  const selectedEdge: EdgeSelection | null = useMemo(() => {
    if (selEdge === null) return null;
    const flowOf = (source: string, target: string): EdgeFlowRecord[] => {
      const record = latestFlowsByPair(edgeFlows).get(pairKey(source, target));
      return record === undefined ? [] : [record];
    };
    const e = edges.find((x) => x.id === selEdge);
    if (e) {
      return {
        id: e.id,
        conditions: e.data.conditions ?? "",
        label: e.label ?? "",
        flows: flowOf(e.source, e.target),
      };
    }
    // Implicit start/end link clicked via a channel line: not part of the
    // definition, so the panel shows its data flow read-only.
    const b = parseBoundaryEdgeId(selEdge);
    if (b === null) return null;
    return b.kind === "start"
      ? {
          id: selEdge,
          conditions: "",
          label: "",
          readOnly: true,
          flows: flowOf(START_ID, b.nodeId),
        }
      : {
          id: selEdge,
          conditions: "",
          label: "",
          readOnly: true,
          flows: flowOf(b.nodeId, END_ID),
        };
  }, [edges, selEdge, edgeFlows]);

  const showFileWrite = fileWriting && flow?.source !== "online";
  /** The sub-flow palette's actions — rendered inside the node palette or,
   *  when the page provides a host, portalled into its own sidebar section. */
  const subflowActions = showFileWrite
    ? {
        selectedCount: selectedNodeIds.length,
        included: [...new Set(Object.values(nodeOrigins))],
        onInclude: includeSubflow,
        onCreate: createSubflow,
        token,
      }
    : undefined;

  return {
    // Props the JSX uses directly
    flow,
    onlineEditing,
    onTogglePanel,
    paletteContainer,
    subflowsContainer,
    onSaveEvalCase,
    onDeleteEvalCase,
    attachExecutionId,
    onDetachExecution,
    // State
    token,
    status,
    setStatus,
    setStatusKind,
    statusKind,
    base,
    setBase,
    nodes,
    setNodes,
    edges,
    setEdges,
    viewport,
    setViewport,
    selBoundary,
    setSelBoundary,
    selectedNodeIds,
    selectedSubflowPath,
    flowSettingsOpen,
    setFlowSettingsOpen,
    isLoading,
    isSaving,
    validation,
    setValidation,
    liveStates,
    setLiveStates,
    runExecutionId,
    setRunExecutionId,
    problemsOpen,
    setProblemsOpen,
    diffOverlay,
    setDiffOverlay,
    copilotPrefill,
    setCopilotPrefill,
    nodeOrigins,
    subflowName,
    setSubflowName,
    loadedKind,
    drafts,
    liveDefinition,
    liveKind,
    activeDraftId,
    viewingLive,
    paletteCollapsed,
    inspectorCollapsed,
    inspectorWidth,
    setInspectorWidth,
    copilotHidden,
    runTraceHidden,
    history,
    subflowHistory,
    canvasKey,
    loadFlow,
    currentDefinition,
    dirty,
    // Handlers & derived values
    handleCopilotAccept,
    handleUndo,
    handleRedo,
    nodeValidation,
    edgeValidation,
    otherWarnings,
    unknownToolsByServer,
    totalErrors,
    totalWarnings,
    addNodeAt,
    updateNode,
    deleteNode,
    renameNode,
    updateEdge,
    deleteEdge,
    handleSelectionChange,
    handleBulkDelete,
    handleDuplicateSelected,
    handleExtractSubflow,
    setNodeOrigin,
    includeSubflow,
    selectSubflowGroup,
    handleDeleteSubflow,
    handleSaveSubflow,
    handleUndoSubflow,
    handleRedoSubflow,
    handleResetSubflow,
    fitViewNonce,
    setFitViewNonce,
    handleAutoLayout,
    referenceEdges,
    rootRef,
    handleSave,
    handleForceOverwrite,
    handleSaveDraft,
    handlePublish,
    handleDiscard,
    handleToggleViewLive,
    handleSelectDraft,
    handleCreateDraft,
    handleDeleteDraft,
    catalog,
    pinFlowId,
    pinRun,
    evaluateVariables,
    runsCtx,
    formulaFlow,
    nodeIdList,
    boundaries,
    boundaryCards,
    setEntry,
    selectNodeById,
    toolFocus,
    handleToolClick,
    selectedFlowNode,
    hasInspectorSelection,
    handlePanelSelect,
    setFocusedField,
    setFieldSelection,
    copilotFocus,
    edgeFlows,
    handleRunFinished,
    selectedEdge,
    showFileWrite,
    subflowActions,
  };
}
