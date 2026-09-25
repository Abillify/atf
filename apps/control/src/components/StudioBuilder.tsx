"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * StudioBuilder — ReactFlow-based canvas for the Studio workspace (Req. 14).
 *
 * - Drag nodes from a searchable palette onto the canvas; DnD serializes into
 *   the flow file via the write endpoint (Req. 14.1 / 14.2).
 * - Non-serializable operations are blocked with a reason (Req. 14.5).
 * - External file conflicts (hash/mtime) are detected and warned; never
 *   silently overwritten (Req. 14.6).
 * - Hot-reload updates the view when the file changes (Req. 14.4).
 * - Undo/redo, multi-select + bulk actions, auto-layout, inline validation,
 *   and an in-canvas "Run & Trace" bar round out the SOTA-builder pass.
 *
 * Reuses: FlowCanvas, NodePropertyPanel, FlowNodePalette, FlowRunDrawer.
 */

import type React from "react";
import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { FlowCanvas, type NodeValidationState, type EdgeValidationState } from "./FlowCanvas";
import {
  NodePropertyPanel,
  FlowSettingsPanel,
  type EdgeSelection,
} from "./NodePropertyPanel";
import { FlowNodePalette } from "./FlowNodePalette";
import { SubflowGroupPanel } from "./SubflowGroupPanel";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { FlowVersionBar } from "./FlowVersionBar";
import { type CopilotFocus, FlowCopilotPanel } from "./FlowCopilotPanel";
import type { NodeState } from "./graph/graphUtils";
import type { DiffOverlay } from "../lib/flow-diff-view";
import {
  flowToGraph,
  graphToFlow,
  makeNode,
  autoPosition,
  emptyFlow,
  uniqueId,
  parseValidationPath,
  referenceEdges as deriveReferenceEdges,
  layoutEditorGraph,
  rewriteNodeReferences,
  NODE_ID_RE,
  type RFNode,
  type RFEdge,
  type ViewportState,
} from "../lib/flow-graph";
import { useFlowHistory } from "../lib/flow-history";
import type {
  FlowDefinition,
  FlowListEntry,
  NodeType,
  FlowValidationReport,
} from "../types/flow";
import { useAuth } from "../lib/auth/useAuth";
import { backendUrl } from "../lib/backend-url";
import { Button } from "../lib/ui";
import type { PlaygroundResult } from "../lib/studio-run";
import { useNodeTypeCatalog } from "../lib/node-types";
import { fetchRunSample, loadPinnedRun, savePinnedRun, type PinnedRun } from "../lib/run-samples";
import { Redo2, Undo2 } from "lucide-react";
import {
  fetchSubflowContent,
  subflowAt,
  subflowBoxes,
  subflowPathFor,
  subflowNodeIds,
  subflowGroup,
  subflowFragment,
  removeSubflow,
  writeSubflowContent,
  subflowLabel,
} from "../lib/subflows";
import { useSubflowHistory, type SubflowSnapshot } from "../lib/subflow-history";
import { EDITOR_NODE_H, EDITOR_NODE_W } from "./graph/GraphLayoutEngine";
import { FormulaProvider, type RunsContext } from "./FormulaEditor";
import { BoundaryPanel } from "./BoundaryPanel";
import type { BoundaryCardInfo } from "./FlowCanvas";
import {
  REQUEST_EVENT_ID,
  RESPONSE_EVENT_ID,
  flowBoundaries,
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
  /** Copilot + Run & Trace bars. */
  assist: boolean;
}

const ALL_PANELS: StudioBuilderPanels = {
  palette: true,
  properties: true,
  assist: true,
};

// ---------------------------------------------------------------------------
// Flow write API helpers
// ---------------------------------------------------------------------------

type WriteSuccessResult = { ok: true; hash: string };
type WriteFailResult = {
  ok: false;
  error: string;
  conflict?: boolean;
  reason?: string;
};
type WriteResult = WriteSuccessResult | WriteFailResult;

async function writeFlowToBackend(
  token: string | null,
  definition: FlowDefinition,
  baseHash: string | undefined,
  format: "yaml" | "json",
): Promise<WriteResult> {
  const body = {
    id: definition.id,
    format,
    definition,
    ...(baseHash !== undefined ? { baseHash } : {}),
  };

  let resp: Response;
  try {
    resp = await fetch(backendUrl("/flows/write"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (resp.status === 409) {
    return {
      ok: false,
      error:
        "Conflict: the flow file was modified externally since you opened it.",
      conflict: true,
    };
  }
  if (resp.status === 422) {
    let detail = "Non-serializable operation — cannot write this flow.";
    try {
      const data = (await resp.json()) as { reason?: string; message?: string };
      detail = data.reason ?? data.message ?? detail;
    } catch {
      /* ignore parse error */
    }
    return { ok: false, error: detail, reason: detail };
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const data = (await resp.json()) as { message?: string };
      detail = data.message ?? detail;
    } catch {
      /* ignore */
    }
    return { ok: false, error: detail };
  }

  let hash = "";
  try {
    const data = (await resp.json()) as { hash?: string };
    hash = data.hash ?? "";
  } catch {
    /* ignore */
  }
  return { ok: true, hash };
}

async function fetchFlowDefinition(
  token: string | null,
  flowId: string,
): Promise<{
  definition: FlowDefinition;
  hash?: string;
  kind: LoadedKind;
  format?: "yaml" | "json";
} | null> {
  try {
    const resp = await fetch(backendUrl(`/flows/${encodeURIComponent(flowId)}`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      source?: "file" | "online";
      version?: number;
      published?: FlowDefinition | null;
      draft?: FlowDefinition | null;
      sourceDefinition?: FlowDefinition;
      file?: { name: string; format: "yaml" | "json" };
      hash?: string;
    };
    // File flows: edit the AUTHORING form (model shortcuts, {{vars.*}} and
    // prompt includes kept as references) — saving the parser-expanded form
    // would bake the expansion into the file/draft.
    const def = data.draft ?? data.sourceDefinition ?? data.published ?? null;
    if (!def) return null;
    const kind: LoadedKind = data.draft
      ? { kind: "draft", version: data.version ?? 0 }
      : data.source === "online"
        ? { kind: "published", version: data.version ?? 0 }
        : { kind: "file" };
    return {
      definition: def,
      kind,
      ...(data.hash !== undefined ? { hash: data.hash } : {}),
      ...(data.file ? { format: data.file.format } : {}),
    };
  } catch {
    return null;
  }
}

/** Which revision of the flow the canvas was loaded from. */
type LoadedKind =
  | { kind: "new" }
  | { kind: "file" }
  | { kind: "draft"; version: number }
  | { kind: "published"; version: number };

type StoreResult =
  | { ok: true; validation?: FlowValidationReport; version?: number }
  | { ok: false; error: string; validation?: FlowValidationReport };

async function readStoreError(resp: Response): Promise<{
  error: string;
  validation?: FlowValidationReport;
}> {
  try {
    const text = await resp.text();
    let data: { error?: { message?: string } | string; validation?: FlowValidationReport } = {};
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      // A plain-text refusal (e.g. the CSRF check's "Forbidden"): show it as is.
      return { error: `HTTP ${resp.status}${text.trim() ? `: ${text.trim().slice(0, 200)}` : ""}` };
    }
    const message = typeof data.error === "string" ? data.error : data.error?.message;
    return {
      error: message ?? `HTTP ${resp.status}`,
      ...(data.validation ? { validation: data.validation } : {}),
    };
  } catch {
    return { error: `HTTP ${resp.status}` };
  }
}

/** PUT /flows/:id/draft — stores a WIP draft; the live flow is untouched. */
async function saveDraftToBackend(
  token: string | null,
  definition: FlowDefinition,
): Promise<StoreResult> {
  try {
    const resp = await fetch(
      backendUrl(`/flows/${encodeURIComponent(definition.id)}/draft`),
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(definition),
      },
    );
    if (!resp.ok) return { ok: false, ...(await readStoreError(resp)) };
    const data = (await resp.json()) as {
      validation?: FlowValidationReport;
      record?: { version?: number };
    };
    return {
      ok: true,
      ...(data.validation ? { validation: data.validation } : {}),
      ...(data.record?.version !== undefined
        ? { version: data.record.version }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** POST /flows/:id/publish — validates the stored draft and makes it live. */
async function publishOnBackend(
  token: string | null,
  flowId: string,
): Promise<StoreResult> {
  try {
    const resp = await fetch(
      backendUrl(`/flows/${encodeURIComponent(flowId)}/publish`),
      {
        method: "POST",
        // A JSON body (even empty): a body-less POST counts as a form post for
        // the runtime's CSRF check and is refused unless strictly same-origin.
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: "{}",
      },
    );
    if (!resp.ok) return { ok: false, ...(await readStoreError(resp)) };
    const data = (await resp.json()) as {
      validation?: FlowValidationReport;
      record?: { version?: number };
    };
    return {
      ok: true,
      ...(data.validation ? { validation: data.validation } : {}),
      ...(data.record?.version !== undefined
        ? { version: data.record.version }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Canonical form for dirty tracking — pan/zoom alone is not an edit. */
function snapshotOf(def: FlowDefinition): string {
  const ui = def.metadata?.ui;
  const layoutOnly = ui ? { ...ui, viewport: undefined } : undefined;
  return JSON.stringify({
    ...def,
    metadata: { ...def.metadata, ui: layoutOnly },
  });
}

async function validateFlowOnBackend(
  token: string | null,
  definition: FlowDefinition,
): Promise<FlowValidationReport | null> {
  try {
    const resp = await fetch(backendUrl("/flows/validate"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(definition),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as FlowValidationReport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyboard-shortcut helpers
// ---------------------------------------------------------------------------

/** Validator message for a tool no connected MCP server offers. */
const UNKNOWN_TOOL_RE = /^tool "([^"]+)" is not known to any connected MCP server$/;

function isEditableTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StudioBuilder({
  flow,
  onSaved,
  onlineEditing = false,
  fileWriting = false,
  onDirtyChange,
  panels = ALL_PANELS,
  onSaveEvalCase,
  onDeleteEvalCase,
  onInspect,
  attachExecutionId,
  onDetachExecution,
  canvasDefinitionRef,
}: StudioBuilderProps): React.JSX.Element {
  const { token, ready, isAuthenticated } = useAuth();

  const [base, setBase] = useState<FlowDefinition>(() =>
    flow ? emptyFlow(flow.id) : emptyFlow("new-flow"),
  );
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [viewport, setViewport] = useState<ViewportState | undefined>(undefined);
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
  const [selectedSubflowPath, setSelectedSubflowPath] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<
    "info" | "error" | "warn" | "ok"
  >("info");
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
  const paletteCollapsed = !panels.palette;
  const inspectorCollapsed = !panels.properties;
  const assistBarsHidden = !panels.assist;

  const history = useFlowHistory({ nodes: [], edges: [] });
  /** Per-sub-flow undo/redo + saved-baseline, scoped to one `$include` group. */
  const subflowHistory = useSubflowHistory();
  /** Positions as loaded — to tell whether the operator actually moved nodes. */
  const loadedPositionsRef = useRef<Map<string, { x: number; y: number }>>(
    new Map(),
  );
  const rememberPositions = (ns: RFNode[]): void => {
    loadedPositionsRef.current = new Map(ns.map((n) => [n.id, n.position]));
  };
  const clipboardRef = useRef<RFNode[]>([]);
  const skipHistoryRef = useRef(false);
  /** Node ids of the last explicit sub-flow-group selection, so the resulting
   * onSelectionChange doesn't clear it (see selectSubflowGroup). */
  const groupSelectionRef = useRef<Set<string> | null>(null);

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
  // -------------------------------------------------------------------------
  const loadFlow = useCallback(
    (flowToLoad: FlowListEntry | null): void => {
      skipHistoryRef.current = true;
      setValidation(null);
      setLiveStates(undefined);
      setDiffOverlay(undefined);

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
        setBaseline(snapshotOf(graphToFlow(empty, g.nodes, g.edges, undefined, g.nodeOrigins ?? {}, false)));
        rememberPositions(g.nodes);
        history.reset({ nodes: g.nodes, edges: g.edges, base: empty, nodeOrigins: g.nodeOrigins ?? {} });
        return;
      }

      setIsLoading(true);
      setStatus(null);

      fetchFlowDefinition(token ?? null, flowToLoad.id)
        .then((result) => {
          if (result) {
            const { definition, hash, kind, format } = result;
            setBase(definition);
            setLoadedKind(kind);
            setFileFormat(format ?? "yaml");
            const g = flowToGraph(definition);
            setNodes(g.nodes);
            setEdges(g.edges);
            setViewport(g.viewport);
            setNodeOrigins(g.nodeOrigins ?? {});
            setBaseHash(hash);
            setBaseline(snapshotOf(graphToFlow(definition, g.nodes, g.edges, undefined, g.nodeOrigins ?? {}, definition.metadata?.ui !== undefined)));
            rememberPositions(g.nodes);
            history.reset({ nodes: g.nodes, edges: g.edges, base: definition, nodeOrigins: g.nodeOrigins ?? {} });
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
            setBaseline(snapshotOf(graphToFlow(empty, g.nodes, g.edges, undefined, g.nodeOrigins ?? {}, false)));
            rememberPositions(g.nodes);
            history.reset({ nodes: g.nodes, edges: g.edges, base: empty, nodeOrigins: g.nodeOrigins ?? {} });
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

  useEffect(() => {
    // Defer loading until auth discovery is done — avoids a redundant
    // unauthenticated fetch followed immediately by an authenticated one when
    // the token hydrates. Gate on isAuthenticated rather than the token: with
    // AUTHN_MODE=disabled there never is a token and the flow must still load.
    if (flow && !(ready && isAuthenticated)) return;
    loadFlow(flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id, ready, isAuthenticated]);

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
  // Copilot accept — replaces the canvas state with the accepted proposal.
  // Picked up by the debounced history effect below as a normal, undoable edit.
  // -------------------------------------------------------------------------
  // Latest proposal preview, so accepting places new nodes where the preview
  // showed them.
  const diffOverlayRef = useRef<DiffOverlay | undefined>(undefined);
  diffOverlayRef.current = diffOverlay;

  const handleCopilotAccept = useCallback(
    (proposed: FlowDefinition): void => {
      setBase(proposed);
      const g = flowToGraph(proposed);
      // Existing nodes stay exactly where they are on the canvas; new ones take
      // the position the preview showed. Only if neither applies does the
      // proposal's own layout decide.
      const current = new Map(nodes.map((n) => [n.id, n.position]));
      const previewed = new Map(
        (diffOverlayRef.current?.ghostNodes ?? []).map((n) => [n.id, n.position]),
      );
      const placed = g.nodes.map((n) => ({
        ...n,
        position: current.get(n.id) ?? previewed.get(n.id) ?? n.position,
      }));
      setNodes(placed);
      setEdges(g.edges);
      setNodeOrigins(g.nodeOrigins ?? {});
    },
    [nodes],
  );

  // -------------------------------------------------------------------------
  // Extract to sub-flow (Phase 4): tags the selected nodes with a new
  // `$includeOrigins` entry. Nodes STAY on the canvas — `$include`-composed
  // flows always show their fully merged graph in one view; the tag only
  // controls which file a node's content is written to on save (see
  // `splitByIncludeOrigin` in `src/routes/flows.ts`). Cross-boundary edges
  // need no special handling: they stay with the parent and still resolve
  // once the files are re-merged on next load.
  // -------------------------------------------------------------------------
  const handleExtractSubflow = useCallback(
    (name: string): void => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const relPath = `subflows/${trimmed}.yaml`;
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      if (selectedIds.length === 0) return;
      setNodeOrigins((prev) => {
        const next = { ...prev };
        for (const id of selectedIds) next[id] = relPath;
        return next;
      });
      setStatus(
        `${selectedIds.length} node(s) tagged for subflows/${trimmed}.yaml — save to write it.`,
      );
      setStatusKind("info");
    },
    [nodes],
  );

  // -------------------------------------------------------------------------
  // Undo/redo history — debounced so a drag gesture or a burst of edits
  // becomes one history entry (see flow-history.ts for the coalescing logic).
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    const t = setTimeout(
      () => history.maybePush({ nodes, edges, base, nodeOrigins }),
      400,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, base, nodeOrigins]);

  const applySnapshot = useCallback(
    (snap: { nodes: RFNode[]; edges: RFEdge[]; base?: FlowDefinition; nodeOrigins?: Record<string, string> }) => {
      skipHistoryRef.current = true;
      setNodes(snap.nodes);
      setEdges(snap.edges);
      if (snap.base) setBase(snap.base);
      if (snap.nodeOrigins) setNodeOrigins(snap.nodeOrigins);
    },
    [],
  );

  const handleUndo = useCallback(() => {
    const snap = history.undo();
    if (snap) applySnapshot(snap);
  }, [history, applySnapshot]);

  const handleRedo = useCallback(() => {
    const snap = history.redo();
    if (snap) applySnapshot(snap);
  }, [history, applySnapshot]);

  // -------------------------------------------------------------------------
  // Inline validation — debounced dry-run against POST /flows/validate.
  // -------------------------------------------------------------------------
  useEffect(() => {
    const def = graphToFlow(base, nodes, edges, viewport);
    const t = setTimeout(() => {
      validateFlowOnBackend(token ?? null, def).then((report) => {
        if (report) setValidation(report);
      });
    }, 500);
    return () => clearTimeout(t);
  }, [base, nodes, edges, viewport, token]);

  const { nodeValidation, edgeValidation } = useMemo(() => {
    const nodeMap = new Map<string, NodeValidationState>();
    const edgeMap = new Map<string, EdgeValidationState>();

    const add = (
      map: Map<string, NodeValidationState | EdgeValidationState>,
      id: string,
      message: string,
      level: "errors" | "warnings",
    ): void => {
      const entry = map.get(id) ?? { errors: [], warnings: [] };
      entry[level].push(message);
      map.set(id, entry);
    };

    if (validation) {
      for (const [issues, level] of [
        [validation.errors, "errors"] as const,
        [validation.warnings, "warnings"] as const,
      ]) {
        for (const issue of issues) {
          // Unknown MCP tools are reported per server below instead of
          // ringing every node that uses a server this runtime can't reach.
          if (level === "warnings" && UNKNOWN_TOOL_RE.test(issue.message)) continue;
          const parsed = parseValidationPath(issue.path, edges);
          if (parsed.kind === "node" && parsed.id) {
            add(nodeMap, parsed.id, issue.message, level);
          } else if (parsed.kind === "edge" && parsed.id) {
            add(edgeMap, parsed.id, issue.message, level);
          }
          // "global" issues (e.g. cycle detection, top-level schema errors)
          // have no node/edge to highlight — they still show up in the raw
          // errors/warnings list rendered in the Problems panel below.
        }
      }
    }
    return { nodeValidation: nodeMap, edgeValidation: edgeMap };
  }, [validation, edges]);

  const { otherWarnings, unknownToolsByServer } = useMemo(() => {
    const byServer = new Map<string, Set<string>>();
    const others: FlowValidationReport["warnings"] = [];
    for (const w of validation?.warnings ?? []) {
      const m = UNKNOWN_TOOL_RE.exec(w.message);
      if (!m) {
        others.push(w);
        continue;
      }
      const tool = m[1]!;
      const server = tool.includes("/") ? tool.slice(0, tool.indexOf("/")) : "(no server prefix)";
      const set = byServer.get(server) ?? new Set<string>();
      set.add(tool);
      byServer.set(server, set);
    }
    return { otherWarnings: others, unknownToolsByServer: byServer };
  }, [validation]);

  const totalErrors = (validation?.errors.length ?? 0);
  const totalWarnings = otherWarnings.length;

  // -------------------------------------------------------------------------
  // Node CRUD
  // -------------------------------------------------------------------------

  const addNodeAt = useCallback(
    (type: NodeType, position?: { x: number; y: number }): void => {
      // Dropped onto a sub-flow box → the new node belongs to that sub-flow.
      const into =
        position !== undefined
          ? subflowAt(
              position,
              subflowBoxes(nodes as never, nodeOrigins, { width: EDITOR_NODE_W, height: EDITOR_NODE_H }),
            )
          : undefined;
      setNodes((ns) => {
        const node = makeNode(
          type,
          ns.map((n) => n.id),
        );
        if (into !== undefined) setNodeOrigins((o) => ({ ...o, [node.id]: into }));
        const pos = position ?? autoPosition(ns.length);
        setSelNode(node.id);
        setSelEdge(null);
        setSelectedNodeIds([node.id]);
        return [
          ...ns,
          { id: node.id, type: "flowNode", position: pos, data: { flowNode: node } },
        ];
      });
    },
    [nodes, nodeOrigins],
  );

  // -------------------------------------------------------------------------
  // Sub-flows: include a file, create a new one, move a node between files.
  // The canvas always shows the merged graph; a node's origin decides which
  // file it is written to on save (the runtime adds new files to
  // metadata.$include and drops files no longer used).
  // -------------------------------------------------------------------------
  const setNodeOrigin = useCallback((nodeId: string, path: string | null): void => {
    setNodeOrigins((o) => {
      const { [nodeId]: _old, ...rest } = o;
      void _old;
      return path ? { ...rest, [nodeId]: path } : rest;
    });
  }, []);

  const includeSubflow = useCallback(
    async (path: string): Promise<string> => {
      const content = await fetchSubflowContent(path, token);
      const existing = new Set(nodes.map((n) => n.id));
      const incoming = content.nodes.filter((n) => !existing.has(n.id));
      const skipped = content.nodes.length - incoming.length;
      if (incoming.length === 0) {
        return skipped > 0 ? `All nodes of ${path} are already on the canvas.` : `${path} has no nodes.`;
      }
      const ids = new Set(incoming.map((n) => n.id));
      const subEdges = content.edges.filter(
        (e) => (ids.has(e.source) || existing.has(e.source)) && (ids.has(e.target) || existing.has(e.target)),
      );
      // Lay the sub-flow out on its own, to the right of the current graph.
      const g = flowToGraph({ id: "sub", name: "sub", nodes: incoming, edges: subEdges.filter((e) => ids.has(e.source) && ids.has(e.target)) });
      const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x + EDITOR_NODE_W), 0);
      const minY = nodes.reduce((m, n) => Math.min(m, n.position.y), Number.POSITIVE_INFINITY);
      const gx = Math.min(...g.nodes.map((n) => n.position.x));
      const gy = Math.min(...g.nodes.map((n) => n.position.y));
      const dx = (nodes.length > 0 ? maxX + 140 : 0) - gx;
      const dy = (Number.isFinite(minY) ? minY : 0) - gy;
      const newNodes = g.nodes.map((n) => ({ ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }));
      const edgeIds = new Set(edges.map((e) => e.id));
      const newEdges = flowToGraph({ id: "sub", name: "sub", nodes: incoming, edges: subEdges }).edges.map((e) => {
        let id = e.id;
        while (edgeIds.has(id)) id = `${id}-sub`;
        edgeIds.add(id);
        return { ...e, id };
      });
      setNodes((ns) => [...ns, ...newNodes]);
      setEdges((es) => [...es, ...newEdges]);
      setNodeOrigins((o) => ({ ...o, ...Object.fromEntries(incoming.map((n) => [n.id, path])) }));
      if (Object.keys(content.edgeOrigins).length > 0) {
        setBase((b) => ({
          ...b,
          metadata: {
            ...(b.metadata ?? {}),
            $includeEdgeOrigins: {
              ...((b.metadata as Record<string, unknown> | undefined)?.["$includeEdgeOrigins"] as Record<string, string> | undefined),
              ...content.edgeOrigins,
            },
          },
        }));
      }
      return `Included ${path}: ${incoming.length} node(s)${skipped > 0 ? `, ${skipped} skipped (id already on the canvas)` : ""} — save to add it to the flow.`;
    },
    [nodes, edges, token],
  );

  const createSubflow = useCallback(
    (name: string): string | null => {
      const path = subflowPathFor(name);
      if (!path) return "Enter a name (letters, digits, - or _).";
      if (Object.values(nodeOrigins).includes(path)) return `${path} already exists in this flow.`;
      const selectedIds = nodes.filter((n) => n.selected).map((n) => n.id);
      if (selectedIds.length > 0) {
        setNodeOrigins((o) => ({ ...o, ...Object.fromEntries(selectedIds.map((id) => [id, path])) }));
        setStatus(`${selectedIds.length} node(s) moved to ${path} — save to write the file.`);
      } else {
        // An empty sub-flow can't be drawn: start it with one node beside the graph.
        const maxX = nodes.reduce((m, n) => Math.max(m, n.position.x + EDITOR_NODE_W), 0);
        const minY = nodes.reduce((m, n) => Math.min(m, n.position.y), Number.POSITIVE_INFINITY);
        setNodes((ns) => {
          const node = makeNode("llm", ns.map((n) => n.id));
          setNodeOrigins((o) => ({ ...o, [node.id]: path }));
          setSelNode(node.id);
          setSelEdge(null);
          setSelectedNodeIds([node.id]);
          return [
            ...ns,
            {
              id: node.id,
              type: "flowNode",
              position: { x: nodes.length > 0 ? maxX + 140 : 0, y: Number.isFinite(minY) ? minY : 0 },
              data: { flowNode: node },
            },
          ];
        });
        setStatus(`Created ${path} with a first node — drop more nodes onto its box, then save.`);
      }
      setStatusKind("info");
      return null;
    },
    [nodes, nodeOrigins],
  );

  // -------------------------------------------------------------------------
  // Sub-flow groups on the canvas — a whole `$include` group can be selected,
  // moved, deleted, saved to its file on its own, and stepped/undone/reset
  // independently of the rest of the flow (see lib/subflows.ts &
  // lib/subflow-history.ts).
  // -------------------------------------------------------------------------

  /** `$includeEdgeOrigins` off `base.metadata` (edge key → sub-flow path). */
  const edgeOrigins = useMemo<Record<string, string>>(
    () => (base.metadata?.["$includeEdgeOrigins"] as Record<string, string> | undefined) ?? {},
    [base.metadata],
  );

  /** The current canvas slice of sub-flow `path` as a history snapshot. */
  const subflowSnapshotOf = useCallback(
    (path: string): SubflowSnapshot => {
      const g = subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path);
      const groupKeys = new Set(g.edges.map((e) => (e.data?.syntheticId ? `${e.source}->${e.target}` : e.id)));
      return {
        nodes: g.nodes,
        edges: g.edges,
        edgeOrigins: Object.fromEntries(
          Object.entries(edgeOrigins).filter(([k, p]) => p === path && groupKeys.has(k)),
        ),
      };
    },
    [nodes, edges, nodeOrigins, edgeOrigins],
  );

  // Record each sub-flow's state for its scoped history, debounced like the
  // global history so a drag/burst becomes one step. A path new to the history
  // seeds its baseline; the debounce reads the latest snapshot via a ref.
  const subflowSnapshotRef = useRef(subflowSnapshotOf);
  subflowSnapshotRef.current = subflowSnapshotOf;
  useEffect(() => {
    const paths = [...new Set(Object.values(nodeOrigins))];
    const t = setTimeout(() => {
      for (const p of paths) subflowHistory.push(p, subflowSnapshotRef.current(p));
    }, 400);
    return () => clearTimeout(t);
  }, [nodes, edges, nodeOrigins, edgeOrigins, subflowHistory]);

  /**
   * Replaces exactly sub-flow `path`'s nodes/edges/edge-origins on the canvas
   * with `snap`, leaving every other node, edge and sub-flow untouched. Used by
   * per-sub-flow undo/redo and reset.
   */
  const applySubflowSnapshot = useCallback(
    (path: string, snap: SubflowSnapshot): void => {
      skipHistoryRef.current = true;
      const oldIds = new Set(subflowNodeIds(nodeOrigins, path));
      const oldEdgeKeys = new Set(
        subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path).edges.map((e) =>
          e.data?.syntheticId ? `${e.source}->${e.target}` : e.id,
        ),
      );
      const newIds = new Set(snap.nodes.map((n) => n.id));
      setNodes((ns) => [...ns.filter((n) => !oldIds.has(n.id)), ...snap.nodes]);
      setEdges((es) => {
        const keep = es.filter((e) => {
          const key = e.data?.syntheticId ? `${e.source}->${e.target}` : e.id;
          return !oldEdgeKeys.has(key);
        });
        return [...keep, ...snap.edges];
      });
      setNodeOrigins((o) => {
        const rest = Object.fromEntries(Object.entries(o).filter(([id]) => !oldIds.has(id)));
        return { ...rest, ...Object.fromEntries([...newIds].map((id) => [id, path])) };
      });
      setBase((b) => {
        const eo = (b.metadata?.["$includeEdgeOrigins"] as Record<string, string> | undefined) ?? {};
        const withoutPath = Object.fromEntries(Object.entries(eo).filter(([, p]) => p !== path));
        const merged = { ...withoutPath, ...snap.edgeOrigins };
        const metadata = { ...(b.metadata ?? {}) } as Record<string, unknown>;
        if (Object.keys(merged).length > 0) metadata["$includeEdgeOrigins"] = merged;
        else delete metadata["$includeEdgeOrigins"];
        return { ...b, metadata };
      });
    },
    [nodes, edges, nodeOrigins, edgeOrigins],
  );

  /**
   * Selects a whole sub-flow group (all its nodes) on the canvas. This is the
   * ONLY way the sub-flow action panel opens — an explicit click on the group's
   * box label/border, never an inferred consequence of selecting a node inside
   * it. Otherwise a single-node sub-flow could never have its node's properties
   * edited (selecting the node would look identical to selecting the group).
   */
  const selectSubflowGroup = useCallback(
    (path: string): void => {
      const ids = new Set(subflowNodeIds(nodeOrigins, path));
      if (ids.size === 0) return;
      // Remember the group's node set so the selection-change that React Flow
      // fires for this programmatic selection doesn't immediately clear the
      // group selection (see handleSelectionChange).
      groupSelectionRef.current = ids;
      setNodes((ns) => ns.map((n) => ({ ...n, selected: ids.has(n.id) })));
      setSelectedNodeIds([...ids]);
      setSelectedSubflowPath(path);
      setSelNode(null);
      setSelEdge(null);
    },
    [nodeOrigins],
  );

  /**
   * Removes a whole sub-flow from THIS flow: its nodes/edges leave the canvas
   * and its `$include` bookkeeping is cleared, so on save the runtime drops the
   * file from `metadata.$include`. The sub-flow FILE on disk is not touched.
   */
  const handleDeleteSubflow = useCallback(
    (path: string): void => {
      const r = removeSubflow(nodes, edges, nodeOrigins, edgeOrigins, path);
      if (r.removedNodeIds.length === 0) return;
      setNodes(r.nodes);
      setEdges(r.edges);
      setNodeOrigins(r.origins);
      setBase((b) => {
        const metadata = { ...(b.metadata ?? {}) } as Record<string, unknown>;
        if (Object.keys(r.edgeOrigins).length > 0) metadata["$includeEdgeOrigins"] = r.edgeOrigins;
        else delete metadata["$includeEdgeOrigins"];
        return { ...b, metadata };
      });
      setSelectedNodeIds([]);
      setSelNode(null);
      setSelEdge(null);
      groupSelectionRef.current = null;
      setSelectedSubflowPath(null);
      subflowHistory.forget(path);
      setStatus(
        `Removed sub-flow ${subflowLabel(path)} from this flow (${r.removedNodeIds.length} node(s)). ` +
          "Its file is kept — save to drop it from this flow's includes. Cmd/Ctrl+Z to undo.",
      );
      setStatusKind("info");
    },
    [nodes, edges, nodeOrigins, edgeOrigins, subflowHistory],
  );

  /** Writes just this sub-flow's file (POST /flows/subflows/write). */
  const handleSaveSubflow = useCallback(
    async (path: string): Promise<void> => {
      const g = subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path);
      if (g.nodes.length === 0) return;
      setStatus(`Saving ${subflowLabel(path)}…`);
      setStatusKind("info");
      try {
        await writeSubflowContent(path, subflowFragment(g), token);
        // The current state is now the saved baseline for this sub-flow.
        subflowHistory.init(path, subflowSnapshotOf(path));
        setStatus(`Saved ${subflowLabel(path)} to its file — live now.`);
        setStatusKind("ok");
      } catch (err) {
        setStatus(`✗ Could not save ${subflowLabel(path)}: ${err instanceof Error ? err.message : String(err)}`);
        setStatusKind("error");
      }
    },
    [nodes, edges, nodeOrigins, edgeOrigins, token, subflowHistory, subflowSnapshotOf],
  );

  const handleUndoSubflow = useCallback(
    (path: string): void => {
      const snap = subflowHistory.undo(path);
      if (snap) {
        applySubflowSnapshot(path, snap);
        setStatus(`Undid an edit in ${subflowLabel(path)}.`);
        setStatusKind("info");
      }
    },
    [subflowHistory, applySubflowSnapshot],
  );

  const handleRedoSubflow = useCallback(
    (path: string): void => {
      const snap = subflowHistory.redo(path);
      if (snap) {
        applySubflowSnapshot(path, snap);
        setStatus(`Redid an edit in ${subflowLabel(path)}.`);
        setStatusKind("info");
      }
    },
    [subflowHistory, applySubflowSnapshot],
  );

  /** Resets a sub-flow to the version on disk (its file), re-fetching it. */
  const handleResetSubflow = useCallback(
    async (path: string): Promise<void> => {
      setStatus(`Resetting ${subflowLabel(path)} to the saved file…`);
      setStatusKind("info");
      try {
        const content = await fetchSubflowContent(path, token);
        // Lay the fetched nodes out where the current group sits, so a reset
        // doesn't jump the group across the canvas.
        const current = subflowGroup(nodes, edges, nodeOrigins, edgeOrigins, path);
        const posById = new Map(current.nodes.map((n) => [n.id, n.position]));
        const anchor = current.nodes[0]?.position ?? { x: 0, y: 0 };
        const g = flowToGraph({ id: "sub", name: "sub", nodes: content.nodes, edges: content.edges });
        const placed = g.nodes.map((n) => ({
          ...n,
          position: posById.get(n.id) ?? anchor,
        }));
        const snap: SubflowSnapshot = {
          nodes: placed,
          edges: g.edges,
          edgeOrigins: Object.fromEntries(
            Object.entries(content.edgeOrigins).map(([k]) => [k, path]),
          ),
        };
        applySubflowSnapshot(path, snap);
        subflowHistory.init(path, snap);
        setStatus(`Reset ${subflowLabel(path)} to the saved file.`);
        setStatusKind("ok");
      } catch (err) {
        setStatus(`✗ Could not reset ${subflowLabel(path)}: ${err instanceof Error ? err.message : String(err)}`);
        setStatusKind("error");
      }
    },
    [nodes, edges, nodeOrigins, edgeOrigins, token, applySubflowSnapshot, subflowHistory],
  );

  const updateNode = useCallback(
    (updated: FlowDefinition["nodes"][number]): void => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === updated.id ? { ...n, data: { flowNode: updated } } : n,
        ),
      );
    },
    [],
  );

  /**
   * Removes nodes AND every reference to them held in other nodes' settings
   * (parallel children, harness allowlist/verifier), so a delete never leaves
   * a dangling id behind. Undoable like any other edit.
   */
  const removeNodes = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      let remaining = nodes
        .filter((n) => !drop.has(n.id))
        .map((n) => n.data.flowNode);
      const changes: string[] = [];
      for (const id of ids) {
        const res = rewriteNodeReferences(remaining, id, null);
        remaining = res.nodes;
        changes.push(...res.changes);
      }
      const byId = new Map(remaining.map((fn) => [fn.id, fn]));
      setNodes((ns) =>
        ns
          .filter((n) => !drop.has(n.id))
          .map((n) => {
            const fn = byId.get(n.id);
            return fn && fn !== n.data.flowNode ? { ...n, data: { ...n.data, flowNode: fn } } : n;
          }),
      );
      setEdges((es) => es.filter((e) => !drop.has(e.source) && !drop.has(e.target)));
      setSelNode(null);
      setSelectedNodeIds([]);
      if (changes.length > 0) {
        setStatus(
          `Deleted ${ids.length} node(s) and removed their references in: ${[...new Set(changes)].join(", ")} (Cmd/Ctrl+Z to undo).`,
        );
        setStatusKind("info");
      }
    },
    [nodes],
  );

  const deleteNode = useCallback((id: string): void => removeNodes([id]), [removeNodes]);

  /**
   * Renames a node and follows every reference: edges, parallel children,
   * harness allowlist/verifier, its sub-flow origin. Returns an error message,
   * or null on success.
   */
  const renameNode = useCallback(
    (oldId: string, newId: string): string | null => {
      const next = newId.trim();
      if (next === oldId) return null;
      if (!NODE_ID_RE.test(next)) {
        return "Use letters, digits, - and _ (must start with a letter or digit).";
      }
      if (nodes.some((n) => n.id === next)) return `A node "${next}" already exists.`;

      const { nodes: rewritten, changes } = rewriteNodeReferences(
        nodes.map((n) => n.data.flowNode),
        oldId,
        next,
      );
      const byId = new Map(rewritten.map((fn) => [fn.id, fn]));
      setNodes((ns) =>
        ns.map((n) => {
          const fn = byId.get(n.id) ?? n.data.flowNode;
          return n.id === oldId
            ? { ...n, id: next, data: { ...n.data, flowNode: { ...fn, id: next } } }
            : fn !== n.data.flowNode
              ? { ...n, data: { ...n.data, flowNode: fn } }
              : n;
        }),
      );
      setEdges((es) =>
        es.map((e) =>
          e.source === oldId || e.target === oldId
            ? {
                ...e,
                source: e.source === oldId ? next : e.source,
                target: e.target === oldId ? next : e.target,
              }
            : e,
        ),
      );
      setNodeOrigins((o) => {
        if (!(oldId in o)) return o;
        const { [oldId]: origin, ...rest } = o;
        return { ...rest, [next]: origin! };
      });
      // Keep the edge-origin bookkeeping of id-less sub-flow edges ("a->b").
      setBase((b) => {
        const eo = b.metadata?.["$includeEdgeOrigins"] as Record<string, string> | undefined;
        if (!eo) return b;
        const renamed = Object.fromEntries(
          Object.entries(eo).map(([k, v]) => {
            const [src, tgt] = k.split("->");
            return tgt !== undefined && (src === oldId || tgt === oldId)
              ? [`${src === oldId ? next : src}->${tgt === oldId ? next : tgt}`, v]
              : [k, v];
          }),
        );
        return { ...b, metadata: { ...b.metadata, $includeEdgeOrigins: renamed } };
      });
      const pos = loadedPositionsRef.current.get(oldId);
      if (pos) loadedPositionsRef.current.set(next, pos);
      setSelNode((cur) => (cur === oldId ? next : cur));
      setSelectedNodeIds((ids) => ids.map((i) => (i === oldId ? next : i)));
      setStatus(
        `Renamed ${oldId} → ${next}${changes.length > 0 ? `; updated ${[...new Set(changes)].join(", ")}` : ""}.`,
      );
      setStatusKind("info");
      return null;
    },
    [nodes],
  );

  const updateEdge = useCallback((sel: EdgeSelection): void => {
    setEdges((es) =>
      es.map((e) =>
        e.id === sel.id
          ? {
              ...e,
              label: sel.label ?? undefined,
              data: { ...e.data, conditions: sel.conditions ?? undefined },
            }
          : e,
      ),
    );
  }, []);

  const deleteEdge = useCallback((id: string): void => {
    setEdges((es) => es.filter((e) => e.id !== id));
    setSelEdge(null);
  }, []);

  // -------------------------------------------------------------------------
  // Selection (single click, box-select, ctrl/cmd-click — all funnel through
  // FlowCanvas's onSelectionChange)
  // -------------------------------------------------------------------------

  const handleSelectionChange = useCallback(
    (nodeIds: string[], edgeIds: string[]): void => {
      setSelectedNodeIds(nodeIds);
      // A group selection is opened explicitly by selectSubflowGroup, which
      // programmatically selects the group's nodes. React Flow then fires this
      // handler once for that change; we consume the one-shot marker and keep
      // the group panel open. EVERY later selection change — including a click
      // on the group's own node(s), which for a single-node sub-flow is the
      // same node set — clears the group selection so the node's property panel
      // takes over. This is what lets a one-node sub-flow's node be edited.
      const pending = groupSelectionRef.current;
      groupSelectionRef.current = null;
      const isProgrammaticGroupSelect =
        pending !== null &&
        pending.size === nodeIds.length &&
        nodeIds.every((id) => pending.has(id));
      if (!isProgrammaticGroupSelect) {
        setSelectedSubflowPath(null);
      }
      if (nodeIds.length === 1) {
        setSelNode(nodeIds[0]!);
        setSelEdge(null);
      } else if (edgeIds.length === 1 && nodeIds.length === 0) {
        setSelEdge(edgeIds[0]!);
        setSelNode(null);
      } else {
        setSelNode(null);
        setSelEdge(null);
      }
    },
    [],
  );

  // -------------------------------------------------------------------------
  // Bulk actions (multi-select)
  // -------------------------------------------------------------------------

  const handleBulkDelete = useCallback(() => {
    removeNodes(selectedNodeIds);
  }, [selectedNodeIds, removeNodes]);

  const handleDuplicateSelected = useCallback(() => {
    setNodes((ns) => {
      const selected = ns.filter((n) => n.selected);
      if (selected.length === 0) return ns;
      const takenIds = ns.map((n) => n.id);
      const clones: RFNode[] = [];
      for (const n of selected) {
        const newId = uniqueId(n.id, [...takenIds, ...clones.map((c) => c.id)]);
        clones.push({
          id: newId,
          type: "flowNode",
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          data: { flowNode: { ...n.data.flowNode, id: newId } },
          selected: true,
        });
      }
      const newIds = clones.map((c) => c.id);
      setSelectedNodeIds(newIds);
      setSelNode(newIds.length === 1 ? newIds[0]! : null);
      return [...ns.map((n) => ({ ...n, selected: false })), ...clones];
    });
  }, []);

  const handleCopySelected = useCallback(() => {
    setNodes((ns) => {
      clipboardRef.current = ns.filter((n) => n.selected);
      return ns;
    });
  }, []);

  const handlePaste = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    setNodes((ns) => {
      const takenIds = ns.map((n) => n.id);
      const clones: RFNode[] = [];
      for (const n of clipboardRef.current) {
        const newId = uniqueId(n.id, [...takenIds, ...clones.map((c) => c.id)]);
        clones.push({
          id: newId,
          type: "flowNode",
          position: { x: n.position.x + 40, y: n.position.y + 40 },
          data: { flowNode: { ...n.data.flowNode, id: newId } },
          selected: true,
        });
      }
      const newIds = clones.map((c) => c.id);
      setSelectedNodeIds(newIds);
      setSelNode(newIds.length === 1 ? newIds[0]! : null);
      return [...ns.map((n) => ({ ...n, selected: false })), ...clones];
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setNodes((ns) => {
      const ids = ns.map((n) => n.id);
      setSelectedNodeIds(ids);
      setSelNode(null);
      return ns.map((n) => ({ ...n, selected: true }));
    });
  }, []);

  // -------------------------------------------------------------------------
  // Auto-layout — one-click hierarchical arrangement via the same Dagre
  // engine the read-only live monitor uses (GraphLayoutEngine.ts).
  // -------------------------------------------------------------------------

  const [fitViewNonce, setFitViewNonce] = useState(0);
  const handleAutoLayout = useCallback(() => {
    setNodes((ns) => {
      // Lay out with the sizes React Flow actually rendered, so long labels
      // can't make neighbours overlap.
      const sizes = new Map<string, { width: number; height: number }>();
      for (const n of ns) {
        const m = (n as { measured?: { width?: number; height?: number } }).measured;
        if (m?.width && m.height) sizes.set(n.id, { width: m.width, height: m.height });
      }
      const positions = layoutEditorGraph(
        ns.map((n) => n.data.flowNode),
        edges.map((e) => ({
          source: e.source,
          target: e.target,
          ...(e.label ? { label: e.label } : {}),
        })),
        sizes,
        nodeOrigins,
      );
      return ns.map((n) => ({
        ...n,
        position: positions[n.id] ?? n.position,
      }));
    });
    setFitViewNonce((v) => v + 1);
  }, [edges, nodeOrigins]);

  // Delegation links fan out from a harness to half the flow; draw them only
  // while that harness is selected so they explain it without cluttering.
  const referenceEdges = useMemo(
    () =>
      deriveReferenceEdges(nodes.map((n) => n.data.flowNode)).filter(
        (r) => r.kind !== "delegates" || selectedNodeIds.includes(r.source),
      ),
    [nodes, selectedNodeIds],
  );

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  // Shortcuts (Cmd/Ctrl+A, Backspace, …) act on the canvas only while the
  // operator is working in the builder — after a click elsewhere on the page
  // (sidebar text, header) the browser's own behaviour applies again.
  const rootRef = useRef<HTMLDivElement>(null);
  const builderActiveRef = useRef(false);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      builderActiveRef.current = rootRef.current?.contains(e.target as Node) ?? false;
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isEditableTarget(e.target)) return;
      const focusInBuilder =
        e.target instanceof Node && e.target !== document.body
          ? (rootRef.current?.contains(e.target) ?? false)
          : builderActiveRef.current;
      if (!focusInBuilder) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();

      if (mod && key === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if (mod && ((key === "z" && e.shiftKey) || key === "y")) {
        e.preventDefault();
        handleRedo();
      } else if (mod && key === "d") {
        e.preventDefault();
        handleDuplicateSelected();
      } else if (mod && key === "a") {
        e.preventDefault();
        handleSelectAll();
      } else if (mod && key === "c") {
        handleCopySelected();
      } else if (mod && key === "v") {
        handlePaste();
      } else if (key === "delete" || key === "backspace") {
        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          handleBulkDelete();
        } else if (selEdge) {
          e.preventDefault();
          deleteEdge(selEdge);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
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
  ]);

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  const handleSave = useCallback(async (): Promise<void> => {
    const def = currentDefinition();
    if (
      !window.confirm(
        `Write "${def.id}" directly to its flow file?\n\n` +
          "The runtime hot-reloads flow files, so this goes LIVE immediately — " +
          "there is no draft or review step. Use \"Save draft\" to stage changes instead.",
      )
    ) {
      return;
    }
    setIsSaving(true);
    setStatus("Writing file…");
    setStatusKind("info");

    const result = await writeFlowToBackend(token ?? null, def, baseHash, fileFormat);

    if (result.ok) {
      setBaseHash(result.hash);
      setBaseline(snapshotOf(def));
      setStatus("Written to file — live now.");
      setStatusKind("ok");
      onSaved?.(def.id);
    } else if (result.conflict) {
      setStatus(
        `⚠ Conflict: the flow file was changed externally. Review your changes and save again to overwrite, or reload to get the latest version.`,
      );
      setStatusKind("warn");
    } else if (result.reason) {
      setStatus(`✗ Blocked: ${result.reason}`);
      setStatusKind("error");
    } else {
      setStatus(`✗ Save failed: ${result.error}`);
      setStatusKind("error");
    }
    setIsSaving(false);
  }, [currentDefinition, token, baseHash, fileFormat, onSaved]);

  const handleForceOverwrite = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    setStatus("Overwriting…");
    setStatusKind("info");
    const def = currentDefinition();
    const result = await writeFlowToBackend(token ?? null, def, undefined, fileFormat);
    if (result.ok) {
      setBaseHash(result.hash);
      setBaseline(snapshotOf(def));
      setStatus("Overwrite successful.");
      setStatusKind("ok");
      onSaved?.(def.id);
    } else {
      setStatus(`✗ Overwrite failed: ${result.error}`);
      setStatusKind("error");
    }
    setIsSaving(false);
  }, [currentDefinition, token, fileFormat, onSaved]);

  const handleSaveDraft = useCallback(async (): Promise<boolean> => {
    const def = currentDefinition();
    setIsSaving(true);
    setStatus("Saving draft…");
    setStatusKind("info");
    const result = await saveDraftToBackend(token ?? null, def);
    setIsSaving(false);
    if (!result.ok) {
      if (result.validation) setValidation(result.validation);
      setStatus(`✗ Draft not saved: ${result.error}`);
      setStatusKind("error");
      return false;
    }
    if (result.validation) setValidation(result.validation);
    setBaseline(snapshotOf(def));
    setLoadedKind({ kind: "draft", version: result.version ?? 0 });
    const issues = result.validation && !result.validation.valid;
    setStatus(
      issues
        ? "Draft saved (has validation errors — fix them before publishing). The live flow is unchanged."
        : "Draft saved. The live flow is unchanged until you publish.",
    );
    setStatusKind(issues ? "warn" : "ok");
    onSaved?.(def.id);
    return true;
  }, [currentDefinition, token, onSaved]);

  const handlePublish = useCallback(async (): Promise<void> => {
    const def = currentDefinition();
    const shadows = flow?.source === "file" || flow?.shadowsFile;
    if (
      !window.confirm(
        `Publish "${def.id}"? It becomes the live version for new requests.` +
          (shadows
            ? "\n\nThis flow also exists as a file — the published online version will take precedence over the file."
            : ""),
      )
    ) {
      return;
    }
    // Publish acts on the stored draft, so store the current canvas first.
    if (dirty || loadedKind.kind !== "draft") {
      const saved = await handleSaveDraft();
      if (!saved) return;
    }
    setIsSaving(true);
    setStatus("Publishing…");
    setStatusKind("info");
    const result = await publishOnBackend(token ?? null, def.id);
    setIsSaving(false);
    if (!result.ok) {
      if (result.validation) setValidation(result.validation);
      setStatus(`✗ Publish blocked: ${result.error}`);
      setStatusKind("error");
      if (result.validation && !result.validation.valid) setProblemsOpen(true);
      return;
    }
    setLoadedKind({ kind: "published", version: result.version ?? 0 });
    setStatus(
      `Published${result.version !== undefined ? ` v${result.version}` : ""} — live now.`,
    );
    setStatusKind("ok");
    onSaved?.(def.id);
  }, [
    currentDefinition,
    flow?.source,
    flow?.shadowsFile,
    dirty,
    loadedKind.kind,
    handleSaveDraft,
    token,
    onSaved,
  ]);

  const handleDiscard = useCallback((): void => {
    if (!window.confirm("Discard all unsaved changes on the canvas?")) return;
    loadFlow(flow);
    setStatus("Changes discarded.");
    setStatusKind("info");
  }, [loadFlow, flow]);

  const catalog = useNodeTypeCatalog();
  // Run data pinned for the expression builder's previews, per flow.
  const pinFlowId = flow?.id ?? "";
  const [pinnedRun, setPinnedRunState] = useState<PinnedRun | null>(null);
  useEffect(() => {
    setPinnedRunState(pinFlowId ? loadPinnedRun(pinFlowId) : null);
  }, [pinFlowId]);
  const setPinnedRun = useCallback(
    (run: PinnedRun | null) => {
      setPinnedRunState(run);
      if (pinFlowId) savePinnedRun(pinFlowId, run);
    },
    [pinFlowId],
  );
  const pinRun = useCallback(
    async (executionId: string) => setPinnedRun(await fetchRunSample(executionId, token)),
    [setPinnedRun, token],
  );
  // Formula previews in the variables table: evaluated by the runtime, so
  // the result is exactly what a flow load produces.
  const evaluateVariables = useCallback(
    async (variables: Record<string, unknown>) => {
      const resp = await fetch(backendUrl("/flows/variables/evaluate"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ variables }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()) as {
        values: Record<string, unknown>;
        errors: Array<{ name: string; message: string }>;
      };
    },
    [token],
  );
  // What the formula editors offer: the flow as it is on the canvas.
  const formulaFlow = useMemo(
    () => ({ nodes: nodes.map((n) => n.data.flowNode), variables: base.variables }),
    [nodes, base.variables],
  );
  const nodeIdList = useMemo(() => nodes.map((n) => n.id), [nodes]);
  const [focusedField, setFocusedField] = useState<string | undefined>(undefined);

  const runsCtx = useMemo<RunsContext | undefined>(
    () => (pinFlowId ? { flowId: pinFlowId, pinned: pinnedRun, onPin: setPinnedRun, token } : undefined),
    [pinFlowId, pinnedRun, setPinnedRun, token],
  );

  // Start / End: the entry and exits as the compiler sees them, and what the
  // cards show — the traced run first, else the pinned one.
  const boundaries = useMemo(
    () =>
      flowBoundaries(
        nodes.map((n) => {
          const fn = n.data.flowNode;
          return { id: fn.id, type: fn.type, parallelNodes: fn.parallelNodes, config: fn.config };
        }),
        edges.map((e) => ({ source: e.source, target: e.target, conditions: e.data?.conditions })),
      ),
    [nodes, edges],
  );
  const boundaryCards = useMemo(() => {
    const req = liveStates?.get(REQUEST_EVENT_ID);
    const res = liveStates?.get(RESPONSE_EVENT_ID);
    const pinnedQuery = pinnedRun ? String(pinnedRun.sample["query"] ?? "") : "";
    const start: BoundaryCardInfo = {
      ...(req?.status ? { status: req.status } : {}),
    };
    const startText = req?.user_prompt ?? req?.prompt ?? (pinnedQuery ? `📌 ${pinnedQuery}` : undefined);
    if (startText) start.summary = startText;
    const end: BoundaryCardInfo = { ...(res?.status ? { status: res.status } : {}) };
    const endText =
      res?.response !== undefined
        ? answerText(res.response)
        : pinnedRun?.response !== undefined
          ? `📌 ${pinnedRun.response}`
          : undefined;
    if (endText) end.summary = endText;
    return { start, end };
  }, [liveStates, pinnedRun]);

  const setEntry = useCallback((id: string) => {
    setNodes((ns) => withEntryFirst(ns, id));
    setStatus(`“${id}” is now the entry — moved to the front of the flow (Cmd/Ctrl+Z to undo).`);
    setStatusKind("info");
  }, []);

  const selectNodeById = useCallback((id: string) => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    setSelNode(id);
    setSelEdge(null);
    setSelBoundary(null);
  }, []);

  const selectedFlowNode = useMemo(
    () => nodes.find((n) => n.id === selNode)?.data.flowNode ?? null,
    [nodes, selNode],
  );

  const inspectedId = selectedFlowNode?.id;
  const inspectedType = selectedFlowNode?.type;
  /** Text selected in the focused settings field (for the Copilot). */
  const [fieldSelection, setFieldSelection] = useState<string | undefined>(undefined);
  useEffect(() => {
    setFocusedField(undefined);
    setFieldSelection(undefined);
  }, [inspectedId]);
  // Remember the selection inside a settings field — it survives the click
  // into the Copilot, which moves the focus away.
  const handlePanelSelect = useCallback((e: React.SyntheticEvent) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (typeof el.selectionStart !== "number" || typeof el.selectionEnd !== "number") return;
    const text = el.value.slice(el.selectionStart, el.selectionEnd);
    setFieldSelection(text.trim() === "" ? undefined : text);
  }, []);

  // What the Copilot is told the user has selected.
  const copilotFocus = useMemo<CopilotFocus | undefined>(() => {
    const nodeIds = selectedNodeIds.length > 0 ? selectedNodeIds : selNode ? [selNode] : [];
    const e = selEdge ? edges.find((x) => x.id === selEdge) : undefined;
    if (nodeIds.length === 0 && !e) return undefined;
    const single = nodeIds.length === 1;
    return {
      nodeIds,
      ...(e ? { edge: { source: e.source, target: e.target } } : {}),
      ...(single && focusedField ? { field: focusedField } : {}),
      ...(single && focusedField && fieldSelection ? { fieldSelection } : {}),
    };
  }, [selectedNodeIds, selNode, selEdge, edges, focusedField, fieldSelection]);
  useEffect(() => {
    onInspect?.(
      inspectedId && inspectedType
        ? { nodeId: inspectedId, type: inspectedType, ...(focusedField ? { field: focusedField } : {}) }
        : null,
    );
  }, [inspectedId, inspectedType, focusedField, onInspect]);

  const selectedEdge: EdgeSelection | null = useMemo(() => {
    const e = edges.find((x) => x.id === selEdge);
    if (!e) return null;
    return {
      id: e.id,
      conditions: e.data.conditions ?? "",
      label: e.label ?? "",
    };
  }, [edges, selEdge]);

  const statusColors: Record<typeof statusKind, string> = {
    info: "text-muted-foreground",
    ok: "text-green-600",
    warn: "text-amber-600",
    error: "text-red-600",
  };

  const revisionBadge = ((): { text: string; cls: string; title: string } => {
    switch (loadedKind.kind) {
      case "new":
        return {
          text: "new · unsaved",
          cls: "bg-muted text-muted-foreground",
          title: "Not stored anywhere yet.",
        };
      case "file":
        return {
          text: "file",
          cls: "bg-muted text-muted-foreground",
          title:
            "Loaded from FLOWS_DIR. Save draft creates an online draft; nothing goes live until you publish.",
        };
      case "draft":
        return {
          text: "draft",
          cls: "bg-amber-50 text-amber-700 border border-amber-200",
          title: "Editing the unpublished draft. The live flow is unchanged.",
        };
      case "published":
        return {
          text: `published v${loadedKind.version}`,
          cls: "bg-green-50 text-green-700 border border-green-200",
          title: "Editing a copy of the live version. Save draft to stage changes.",
        };
    }
  })();
  const showFileWrite = fileWriting && flow?.source !== "online";

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading flow…
      </div>
    );
  }

  return (
    <FormulaProvider
      flow={formulaFlow}
      catalog={catalog}
      evaluateVariables={evaluateVariables}
      runs={runsCtx}
    >
    <div ref={rootRef} className="flex h-full flex-col gap-2 overflow-y-auto">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {base.id}
        </span>
        <span
          className={`rounded px-1.5 text-[10px] uppercase ${revisionBadge.cls}`}
          title={revisionBadge.title}
        >
          {revisionBadge.text}
        </span>
        {dirty && (
          <span
            className="rounded bg-blue-50 px-1.5 text-[10px] font-medium uppercase text-blue-700 border border-blue-200"
            title="The canvas has changes that are not stored anywhere yet."
          >
            ● unsaved
          </span>
        )}

        {/* Undo/redo: a bordered button group with icon + label so it reads
            as controls, not as decoration. */}
        <div className="flex items-center overflow-hidden rounded-md border border-border bg-card shadow-sm" role="group" aria-label="History">
          <button type="button"
            onClick={handleUndo}
            disabled={!history.canUndo}
            title="Undo the last change (Cmd/Ctrl+Z)"
            aria-label="Undo"
            className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          >
            <Undo2 size={14} aria-hidden />
            Undo
          </button>
          <button type="button"
            onClick={handleRedo}
            disabled={!history.canRedo}
            title="Redo the last undone change (Cmd/Ctrl+Shift+Z)"
            aria-label="Redo"
            className="flex items-center gap-1 border-l border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground/50 disabled:hover:bg-transparent"
          >
            <Redo2 size={14} aria-hidden />
            Redo
          </button>
        </div>

        {/* Validation summary */}
        {(totalErrors > 0 || totalWarnings > 0) && (
          <button type="button"
            onClick={() => setProblemsOpen((v) => !v)}
            className={`rounded px-2 py-0.5 text-[11px] font-medium ${
              totalErrors > 0
                ? "bg-red-50 text-red-700 border border-red-200"
                : "bg-amber-50 text-amber-700 border border-amber-200"
            }`}
          >
            {totalErrors > 0 ? `${totalErrors} error(s)` : `${totalWarnings} warning(s)`}
          </button>
        )}
        {unknownToolsByServer.size > 0 && (
          <button
            type="button"
            onClick={() => setProblemsOpen((v) => !v)}
            title={`Tools on MCP servers this runtime isn't connected to: ${[...unknownToolsByServer.keys()].join(", ")}. They can't be checked here; they will work where those servers are connected.`}
            className="rounded border border-border bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            {unknownToolsByServer.size} MCP server(s) not connected
          </button>
        )}

        <FlowVersionBar
          flowId={base.id}
          token={token ?? undefined}
          hasDraft={flow?.hasDraft ?? false}
          nodes={nodes}
          edges={edges}
          onDiffOverlayChange={setDiffOverlay}
          onRolledBack={() => loadFlow(flow)}
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              disabled={isSaving}
              onClick={handleDiscard}
              title="Reload the stored version and drop canvas changes"
            >
              Discard
            </Button>
          )}
          {showFileWrite && (
            <Button
              variant={onlineEditing ? "outline" : "primary"}
              size="sm"
              disabled={isSaving}
              onClick={() => {
                void handleSave();
              }}
              title="Write straight into the flow file in FLOWS_DIR — live immediately, no draft."
            >
              Write to file
            </Button>
          )}
          {onlineEditing && (
            <>
              <Button
                variant="secondary"
                size="sm"
                disabled={isSaving}
                onClick={() => {
                  void handleSaveDraft();
                }}
                title="Store the canvas as an unpublished draft. Nothing goes live."
              >
                {isSaving ? "Saving…" : "Save draft"}
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={isSaving || totalErrors > 0}
                onClick={() => {
                  void handlePublish();
                }}
                title={
                  totalErrors > 0
                    ? "Fix the validation errors first."
                    : "Save the draft and make it the live version."
                }
              >
                Publish
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Status bar */}
      {status && (
        <div
          className={`flex items-center gap-2 text-xs ${statusColors[statusKind]}`}
        >
          <span>{status}</span>
          {statusKind === "warn" && status.startsWith("⚠ Conflict") && (
            <button type="button"
              onClick={() => {
                void handleForceOverwrite();
              }}
              className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-amber-700 border border-amber-200 hover:bg-amber-100"
            >
              Overwrite anyway
            </button>
          )}
          <button type="button"
            onClick={() => setStatus(null)}
            aria-label="Dismiss status"
            className="ml-auto rounded px-1 text-muted-foreground hover:text-foreground"
          >
            ×
          </button>
        </div>
      )}

      {/* Problems panel */}
      {problemsOpen && (totalErrors > 0 || totalWarnings > 0 || unknownToolsByServer.size > 0) && (
        <div className="max-h-48 overflow-auto rounded border border-border bg-muted p-2 text-xs space-y-1">
          {validation?.errors.map((issue, i) => (
            <div key={`err-${i}`} className="flex items-center gap-2 text-red-600">
              <span className="flex-1">
                ✗ {issue.path}: {issue.message}
              </span>
              <button type="button"
                onClick={() =>
                  setCopilotPrefill({
                    instruction: `Fix this issue: ${issue.message}`,
                    nonce: Date.now(),
                  })
                }
                className="shrink-0 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 border border-purple-200 hover:bg-purple-100"
              >
                Fix with Copilot
              </button>
            </div>
          ))}
          {otherWarnings.map((issue, i) => (
            <div key={`warn-${i}`} className="flex items-center gap-2 text-amber-600">
              <span className="flex-1">
                ⚠ {issue.path}: {issue.message}
              </span>
              <button type="button"
                onClick={() =>
                  setCopilotPrefill({
                    instruction: `Fix this issue: ${issue.message}`,
                    nonce: Date.now(),
                  })
                }
                className="shrink-0 rounded bg-purple-50 px-1.5 py-0.5 text-[10px] font-medium text-purple-700 border border-purple-200 hover:bg-purple-100"
              >
                Fix with Copilot
              </button>
            </div>
          ))}
          {unknownToolsByServer.size > 0 && (
            <details className="text-muted-foreground">
              <summary className="cursor-pointer">
                ⓘ {[...unknownToolsByServer.values()].reduce((n, t) => n + t.size, 0)} tool
                reference(s) on {unknownToolsByServer.size} MCP server(s) this runtime
                isn&apos;t connected to — not checkable here, not an error in the flow.
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4">
                {[...unknownToolsByServer.entries()].map(([server, tools]) => (
                  <li key={server}>
                    <span className="font-mono text-foreground">{server}</span>:{" "}
                    <span className="font-mono">
                      {[...tools].map((t) => t.slice(server.length + 1) || t).join(", ")}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Copilot (Phase 3) + Run & Trace (Phase 1) side by side on wide
          screens so they cost one row of height instead of two. */}
      <div
        className={`grid gap-2 xl:grid-cols-2 ${assistBarsHidden ? "hidden" : ""}`}
      >
        <FlowCopilotPanel
          key={`copilot-${canvasKey}`}
          flowId={base.id}
          token={token ?? undefined}
          getDefinition={currentDefinition}
          nodes={nodes}
          edges={edges}
          {...(copilotFocus ? { focus: copilotFocus } : {})}
          onPreviewChange={(overlay) => {
            setDiffOverlay(overlay);
            // Proposed nodes may land outside the current view — bring the
            // whole preview into sight.
            if (overlay && overlay.ghostNodes.length > 0) setFitViewNonce((v) => v + 1);
          }}
          onAccept={handleCopilotAccept}
          prefill={copilotPrefill}
        />
        <FlowRunDrawer
          key={canvasKey}
          flowId={base.id}
          onLiveStatesChange={setLiveStates}
          getDefinition={currentDefinition}
          liveAvailable={
            flow !== null && (flow.source === "file" || flow.status === "published")
          }
          onValidationFailed={(report) => {
            setValidation(report);
            setProblemsOpen(true);
          }}
          {...(onSaveEvalCase ? { onSaveEvalCase } : {})}
          {...(onDeleteEvalCase ? { onDeleteEvalCase } : {})}
          {...(pinFlowId ? { onPinRun: pinRun } : {})}
          {...(attachExecutionId ? { attachExecutionId } : {})}
          {...(onDetachExecution ? { onDetach: onDetachExecution } : {})}
        />
      </div>

      {/* Palette + canvas + property panel.
          `min-h-[320px]` keeps the graph usable even when the Copilot proposal
          or Problems panel above it expands, and `flex-1` lets it grow to fill
          the remaining Builder height; the parent column scrolls if the stacked
          controls ever exceed the available space. */}
      <div className="flex flex-1 min-h-[320px] gap-3 overflow-hidden">
        <FlowNodePalette
          collapsed={paletteCollapsed}
          onAddNode={(type) => addNodeAt(type)}
          subflows={
            showFileWrite
              ? {
                  selectedCount: selectedNodeIds.length,
                  included: [...new Set(Object.values(nodeOrigins))],
                  onInclude: includeSubflow,
                  onCreate: createSubflow,
                  token,
                }
              : undefined
          }
        />

        <div className="flex-1 min-h-0 min-w-0">
          <FlowCanvas
            key={canvasKey}
            nodes={nodes}
            edges={edges}
            editable
            onNodesChange={setNodes}
            onEdgesChange={setEdges}
            onSelectionChange={handleSelectionChange}
            onDropNodeType={addNodeAt}
            liveStates={liveStates}
            nodeValidation={nodeValidation}
            edgeValidation={edgeValidation}
            nodeDiff={diffOverlay?.nodeDiff}
            edgeDiff={diffOverlay?.edgeDiff}
            ghostNodes={diffOverlay?.ghostNodes}
            ghostEdges={diffOverlay?.ghostEdges}
            nodeOrigins={nodeOrigins}
            onViewportChange={setViewport}
            referenceEdges={referenceEdges}
            onAutoLayout={handleAutoLayout}
            fitViewNonce={fitViewNonce}
            onInvalidConnection={(reason) => {
              setStatus(`✗ ${reason}`);
              setStatusKind("error");
            }}
            onSelectSubflow={selectSubflowGroup}
            selectedSubflowPath={selectedSubflowPath}
            boundaries={boundaryCards}
            onSelectBoundary={setSelBoundary}
            onSetEntry={setEntry}
            {...(viewport !== undefined ? { defaultViewport: viewport } : {})}
            height="100%"
          />
        </div>

        {/* Node/edge property panel, or bulk-action bar when multiple nodes are selected.
            tabIndex=0 so the scrollable region is keyboard-accessible even when
            it holds no focusable children (empty state) — WCAG 2.1.1. */}
        {!inspectorCollapsed && (
        <aside
          tabIndex={0}
          aria-label="Node properties"
          className="w-80 shrink-0 overflow-auto rounded-lg border border-border bg-card p-3 text-sm"
          onSelect={handlePanelSelect}
          // Runs before the field's own onFocus, which reports its name again —
          // so a field that doesn't report one isn't mistaken for the last.
          onFocusCapture={() => {
            setFocusedField(undefined);
            setFieldSelection(undefined);
          }}
        >
          {selectedSubflowPath !== null ? (
            <SubflowGroupPanel
              path={selectedSubflowPath}
              nodeCount={selectedNodeIds.length}
              canUndo={subflowHistory.canUndo(selectedSubflowPath)}
              canRedo={subflowHistory.canRedo(selectedSubflowPath)}
              dirty={subflowHistory.isDirty(selectedSubflowPath)}
              onSave={() => void handleSaveSubflow(selectedSubflowPath)}
              onUndo={() => handleUndoSubflow(selectedSubflowPath)}
              onRedo={() => handleRedoSubflow(selectedSubflowPath)}
              onReset={() => void handleResetSubflow(selectedSubflowPath)}
              onRemove={() => handleDeleteSubflow(selectedSubflowPath)}
            />
          ) : selectedNodeIds.length > 1 ? (
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-foreground">
                {selectedNodeIds.length} nodes selected
              </h4>
              <div className="flex flex-col gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleDuplicateSelected}
                >
                  Duplicate (Cmd/Ctrl+D)
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleBulkDelete}
                >
                  Delete selected
                </Button>
              </div>

              <div className="border-t border-border pt-3">
                <label
                  htmlFor="subflow-name"
                  className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  Extract to sub-flow
                </label>
                <div className="flex gap-1.5">
                  <input
                    id="subflow-name"
                    value={subflowName}
                    onChange={(e) => setSubflowName(e.target.value)}
                    placeholder="name"
                    className="min-w-0 flex-1 rounded border border-border px-2 py-1 text-xs"
                  />
                  <button type="button"
                    onClick={() => {
                      handleExtractSubflow(subflowName);
                      setSubflowName("");
                    }}
                    disabled={!subflowName.trim()}
                    className="rounded bg-teal-50 px-2 py-1 text-xs font-medium text-teal-700 border border-teal-200 hover:bg-teal-100 disabled:opacity-40"
                  >
                    Extract
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Writes to subflows/{subflowName.trim() || "name"}.yaml on next save. Nodes stay on this canvas.
                </p>
              </div>
            </div>
          ) : selBoundary !== null ? (
            <BoundaryPanel
              kind={selBoundary}
              boundaries={boundaries}
              {...(runsCtx ? { runs: runsCtx } : {})}
              {...(liveStates?.get(selBoundary === "start" ? REQUEST_EVENT_ID : RESPONSE_EVENT_ID)
                ? { current: liveStates.get(selBoundary === "start" ? REQUEST_EVENT_ID : RESPONSE_EVENT_ID)! }
                : {})}
              onSelectNode={selectNodeById}
            />
          ) : (
            <NodePropertyPanel
              {...(showFileWrite && selectedFlowNode
                ? {
                    origin: nodeOrigins[selectedFlowNode.id],
                    originOptions: [...new Set(Object.values(nodeOrigins))],
                    onOriginChange: (path: string | null) => setNodeOrigin(selectedFlowNode.id, path),
                  }
                : {})}
              node={selectedFlowNode}
              edge={selectedEdge}
              onNodeChange={updateNode}
              onDeleteNode={deleteNode}
              onRenameNode={renameNode}
              {...(catalog ? { catalog } : {})}
              nodeIds={nodeIdList}
              onFocusField={setFocusedField}
              authToken={token ?? undefined}
              onEdgeChange={updateEdge}
              onDeleteEdge={deleteEdge}
              emptyContent={
                <FlowSettingsPanel
                  flow={base}
                  idEditable={flow === null}
                  onChange={setBase}
                  {...(catalog ? { catalog } : {})}
                  evaluateVariables={evaluateVariables}
                />
              }
            />
          )}
        </aside>
        )}
      </div>
    </div>
    </FormulaProvider>
  );
}
