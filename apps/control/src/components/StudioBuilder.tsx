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

import React, {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { FlowCanvas, type NodeValidationState, type EdgeValidationState } from "./FlowCanvas";
import { NodePropertyPanel, type EdgeSelection } from "./NodePropertyPanel";
import { FlowNodePalette } from "./FlowNodePalette";
import { FlowRunDrawer } from "./FlowRunDrawer";
import { FlowVersionBar } from "./FlowVersionBar";
import { FlowCopilotPanel } from "./FlowCopilotPanel";
import { computeDagreLayout } from "./graph/GraphLayoutEngine";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StudioBuilderProps {
  /** Currently selected flow (from the flow list). Null for a new unsaved flow. */
  flow: FlowListEntry | null;
  /** Called when the builder saves successfully — parent may refresh the flow list. */
  onSaved?: (flowId: string) => void;
}

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
): Promise<WriteResult> {
  const body = {
    id: definition.id,
    format: "json",
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
): Promise<{ definition: FlowDefinition; hash?: string } | null> {
  try {
    const resp = await fetch(backendUrl(`/flows/${encodeURIComponent(flowId)}`), {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      published?: FlowDefinition;
      draft?: FlowDefinition;
      hash?: string;
    };
    const def = data.draft ?? data.published ?? null;
    if (!def) return null;
    return { definition: def, hash: data.hash };
  } catch {
    return null;
  }
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
}: StudioBuilderProps): React.JSX.Element {
  const { token } = useAuth();

  const [base, setBase] = useState<FlowDefinition>(() =>
    flow ? emptyFlow(flow.id) : emptyFlow("new-flow"),
  );
  const [nodes, setNodes] = useState<RFNode[]>([]);
  const [edges, setEdges] = useState<RFEdge[]>([]);
  const [viewport, setViewport] = useState<ViewportState | undefined>(undefined);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [statusKind, setStatusKind] = useState<
    "info" | "error" | "warn" | "ok"
  >("info");
  const [baseHash, setBaseHash] = useState<string | undefined>(undefined);
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

  const history = useFlowHistory({ nodes: [], edges: [] });
  const clipboardRef = useRef<RFNode[]>([]);
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
        history.reset({ nodes: g.nodes, edges: g.edges });
        return;
      }

      setIsLoading(true);
      setStatus(null);

      fetchFlowDefinition(token ?? null, flowToLoad.id)
        .then((result) => {
          if (result) {
            const { definition, hash } = result;
            setBase(definition);
            const g = flowToGraph(definition);
            setNodes(g.nodes);
            setEdges(g.edges);
            setViewport(g.viewport);
            setNodeOrigins(g.nodeOrigins ?? {});
            setBaseHash(hash);
            history.reset({ nodes: g.nodes, edges: g.edges });
          } else {
            const empty = emptyFlow(flowToLoad.id);
            setBase(empty);
            const g = flowToGraph(empty);
            setNodes(g.nodes);
            setEdges(g.edges);
            setViewport(g.viewport);
            setNodeOrigins(g.nodeOrigins ?? {});
            setBaseHash(undefined);
            history.reset({ nodes: g.nodes, edges: g.edges });
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
    // Defer loading until the auth token is available when a real flow is
    // requested — avoids a redundant unauthenticated fetch followed immediately
    // by an authenticated one when the token hydrates from localStorage.
    if (flow && !token) return;
    loadFlow(flow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow?.id, token]);

  const currentDefinition = useCallback(
    (): FlowDefinition => graphToFlow(base, nodes, edges, viewport, nodeOrigins),
    [base, nodes, edges, viewport, nodeOrigins],
  );

  // -------------------------------------------------------------------------
  // Copilot accept — replaces the canvas state with the accepted proposal.
  // Picked up by the debounced history effect below as a normal, undoable edit.
  // -------------------------------------------------------------------------
  const handleCopilotAccept = useCallback((proposed: FlowDefinition): void => {
    setBase(proposed);
    const g = flowToGraph(proposed);
    setNodes(g.nodes);
    setEdges(g.edges);
    setNodeOrigins(g.nodeOrigins ?? {});
  }, []);

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
    const t = setTimeout(() => history.maybePush({ nodes, edges }), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const handleUndo = useCallback(() => {
    const snap = history.undo();
    if (!snap) return;
    skipHistoryRef.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
  }, [history]);

  const handleRedo = useCallback(() => {
    const snap = history.redo();
    if (!snap) return;
    skipHistoryRef.current = true;
    setNodes(snap.nodes);
    setEdges(snap.edges);
  }, [history]);

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

  const totalErrors = (validation?.errors.length ?? 0);
  const totalWarnings = (validation?.warnings.length ?? 0);

  // -------------------------------------------------------------------------
  // Node CRUD
  // -------------------------------------------------------------------------

  const addNodeAt = useCallback(
    (type: NodeType, position?: { x: number; y: number }): void => {
      setNodes((ns) => {
        const node = makeNode(
          type,
          ns.map((n) => n.id),
        );
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
    [],
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

  const deleteNode = useCallback((id: string): void => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelNode(null);
    setSelectedNodeIds((ids) => ids.filter((i) => i !== id));
  }, []);

  const updateEdge = useCallback((sel: EdgeSelection): void => {
    setEdges((es) =>
      es.map((e) =>
        e.id === sel.id
          ? {
              ...e,
              label: sel.label ?? undefined,
              data: { conditions: sel.conditions ?? undefined },
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
    setNodes((ns) => {
      const keepIds = new Set(ns.filter((n) => !n.selected).map((n) => n.id));
      setEdges((es) =>
        es.filter((e) => keepIds.has(e.source) && keepIds.has(e.target)),
      );
      return ns.filter((n) => !n.selected);
    });
    setSelNode(null);
    setSelectedNodeIds([]);
  }, []);

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

  const handleAutoLayout = useCallback(() => {
    setNodes((ns) => {
      const positions = computeDagreLayout(
        ns.map((n) => n.id),
        edges.map((e) => ({ source: e.source, target: e.target })),
      );
      return ns.map((n) => ({
        ...n,
        position: positions.get(n.id) ?? n.position,
      }));
    });
  }, [edges]);

  // -------------------------------------------------------------------------
  // Keyboard shortcuts
  // -------------------------------------------------------------------------

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isEditableTarget(e.target)) return;
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
    setIsSaving(true);
    setStatus("Saving…");
    setStatusKind("info");

    const def = currentDefinition();
    const result = await writeFlowToBackend(token ?? null, def, baseHash);

    if (result.ok) {
      setBaseHash(result.hash);
      setStatus("Saved successfully.");
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
  }, [currentDefinition, token, baseHash, onSaved]);

  const handleForceOverwrite = useCallback(async (): Promise<void> => {
    setIsSaving(true);
    setStatus("Overwriting…");
    setStatusKind("info");
    const def = currentDefinition();
    const result = await writeFlowToBackend(token ?? null, def, undefined);
    if (result.ok) {
      setBaseHash(result.hash);
      setStatus("Overwrite successful.");
      setStatusKind("ok");
      onSaved?.(def.id);
    } else {
      setStatus(`✗ Overwrite failed: ${result.error}`);
      setStatusKind("error");
    }
    setIsSaving(false);
  }, [currentDefinition, token, onSaved]);

  const selectedFlowNode = useMemo(
    () => nodes.find((n) => n.id === selNode)?.data.flowNode ?? null,
    [nodes, selNode],
  );

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

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading flow…
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
        <span className="font-mono text-sm font-semibold text-foreground">
          {base.id}
        </span>
        {flow?.source && (
          <span className="rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
            {flow.source}
          </span>
        )}

        <div className="flex items-center gap-1">
          <button
            onClick={handleUndo}
            disabled={!history.canUndo}
            title="Undo (Cmd/Ctrl+Z)"
            aria-label="Undo"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
          >
            ↶
          </button>
          <button
            onClick={handleRedo}
            disabled={!history.canRedo}
            title="Redo (Cmd/Ctrl+Shift+Z)"
            aria-label="Redo"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-30"
          >
            ↷
          </button>
          <button
            onClick={handleAutoLayout}
            title="Tidy up (auto-layout)"
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            ⇕ Tidy up
          </button>
        </div>

        {/* Validation summary */}
        {(totalErrors > 0 || totalWarnings > 0) && (
          <button
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
          <Button
            variant="primary"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              void handleSave();
            }}
          >
            {isSaving ? "Saving…" : "Save to file"}
          </Button>
        </div>
      </div>

      {/* Status bar */}
      {status && (
        <div
          className={`flex items-center gap-2 text-xs ${statusColors[statusKind]}`}
        >
          <span>{status}</span>
          {statusKind === "warn" && (
            <button
              onClick={() => {
                void handleForceOverwrite();
              }}
              className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-amber-700 border border-amber-200 hover:bg-amber-100"
            >
              Overwrite anyway
            </button>
          )}
        </div>
      )}

      {/* Problems panel */}
      {problemsOpen && (totalErrors > 0 || totalWarnings > 0) && (
        <div className="max-h-32 overflow-auto rounded border border-border bg-muted p-2 text-xs space-y-1">
          {validation?.errors.map((issue, i) => (
            <div key={`err-${i}`} className="flex items-center gap-2 text-red-600">
              <span className="flex-1">
                ✗ {issue.path}: {issue.message}
              </span>
              <button
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
          {validation?.warnings.map((issue, i) => (
            <div key={`warn-${i}`} className="flex items-center gap-2 text-amber-600">
              <span className="flex-1">
                ⚠ {issue.path}: {issue.message}
              </span>
              <button
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
        </div>
      )}

      {/* Copilot (Phase 3: KI-Copilot im Builder) */}
      <FlowCopilotPanel
        key={canvasKey}
        flowId={base.id}
        token={token ?? undefined}
        getDefinition={currentDefinition}
        nodes={nodes}
        edges={edges}
        onPreviewChange={setDiffOverlay}
        onAccept={handleCopilotAccept}
        prefill={copilotPrefill}
      />

      {/* Run & Trace bar (Phase 1: Live-Test & Trace im Canvas) */}
      <FlowRunDrawer key={canvasKey} flowId={base.id} onLiveStatesChange={setLiveStates} />

      {/* Palette + canvas + property panel.
          `min-h-[320px]` keeps the graph usable even when the Copilot proposal
          or Problems panel above it expands, and `flex-1` lets it grow to fill
          the remaining Builder height; the parent column scrolls if the stacked
          controls ever exceed the available space. */}
      <div className="flex flex-1 min-h-[320px] gap-3 overflow-hidden">
        <FlowNodePalette onAddNode={(type) => addNodeAt(type)} />

        <div className="flex-1 min-h-0">
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
            {...(viewport !== undefined ? { defaultViewport: viewport } : {})}
            height="100%"
          />
        </div>

        {/* Node/edge property panel, or bulk-action bar when multiple nodes are selected.
            tabIndex=0 so the scrollable region is keyboard-accessible even when
            it holds no focusable children (empty state) — WCAG 2.1.1. */}
        <aside
          tabIndex={0}
          aria-label="Node properties"
          className="w-64 shrink-0 overflow-auto rounded-lg border border-border bg-card p-3 text-sm"
        >
          {selectedNodeIds.length > 1 ? (
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
                  <button
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
          ) : (
            <NodePropertyPanel
              node={selectedFlowNode}
              edge={selectedEdge}
              onNodeChange={updateNode}
              onDeleteNode={deleteNode}
              onEdgeChange={updateEdge}
              onDeleteEdge={deleteEdge}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
