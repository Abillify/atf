"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /studio — Studio workspace route (Req. 14.1, 15.1, 16.1, 17.3, 21.1).
 *
 * Grid layout:
 *   - Builder (left/main): ReactFlow canvas + NodePropertyPanel
 *   - Run & Trace (in the builder): test the canvas or the live flow, save eval cases
 *   - Optimize (right): Routing recommendations + Eval summary
 *
 * Write/mutation controls are gated with <RequireRole role="operator"> (Req. 21.1).
 *
 * Heavy components are lazy-loaded (code-splitting, Req. 12.3).
 */

import dynamic from "next/dynamic";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { OptimizePanel } from "../../../components/OptimizePanel";
import type { FlowDefinition } from "../../../types/flow";
import { useAuth } from "../../../lib/auth/useAuth";
import { RequireRole } from "../../../lib/auth/RequireRole";
import { Button } from "../../../lib/ui";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FlowListEntry } from "../../../types/flow";
import type { PlaygroundResult } from "../../../lib/studio-run";
import { FlowPicker } from "../../../components/FlowPicker";
import { NodeTypeDocs } from "../../../components/NodeTypeDocs";
import { useNodeDocs } from "../../../hooks/useNodeDocs";
import { useNodeTypeCatalog } from "../../../lib/node-types";
import {
  validateStudioEvalCase,
  buildStudioEvalCase,
} from "../../../lib/studio-eval-case";
import { backendUrl } from "../../../lib/backend-url";
import { usePersistentToggle } from "../../../hooks/usePersistentToggle";
import {
  PanelToggle,
  PanelToggleGroup,
} from "../../../components/PanelToggle";
import {
  Maximize2,
  Minimize2,
  Shapes,
  SlidersHorizontal,
  Sparkles,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  BookOpen,
} from "lucide-react";

// Lazy-load heavy components (Req. 12.3)
const FlowDiffPanel = dynamic(
  () =>
    import("../../../components/FlowDiffPanel").then((m) => m.FlowDiffPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <span>Loading diff…</span>
      </div>
    ),
  },
);

const AutopilotPanel = dynamic(
  () =>
    import("../../../components/AutopilotPanel").then((m) => m.AutopilotPanel),
  {
    ssr: false,
    loading: () => <div className="text-xs text-muted-foreground py-2">Loading…</div>,
  },
);

const StudioBuilder = dynamic(
  () =>
    import("../../../components/StudioBuilder").then((m) => m.StudioBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading builder…
      </div>
    ),
  },
);

// ---------------------------------------------------------------------------
// Data fetching
// ---------------------------------------------------------------------------

interface FlowListResponse {
  flows: FlowListEntry[];
  /** Backend has a FlowStore — drafts and publish are available. */
  onlineEditing: boolean;
  /** Backend accepts writes into FLOWS_DIR. */
  fileWriting: boolean;
}

async function fetchFlowList(
  token: string | undefined,
): Promise<FlowListResponse> {
  const resp = await fetch(backendUrl("/flows"), {
    // Header nur mit echtem Token; bei AUTHN_MODE=disabled anonym anfragen.
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = (await resp.json()) as
    | { flows?: FlowListEntry[]; onlineEditing?: boolean; fileWriting?: boolean }
    | FlowListEntry[];
  return Array.isArray(data)
    ? { flows: data, onlineEditing: false, fileWriting: false }
    : {
        flows: data.flows ?? [],
        onlineEditing: data.onlineEditing ?? false,
        fileWriting: data.fileWriting ?? false,
      };
}

async function postEvalCase(
  token: string | undefined,
  evalCase: unknown,
): Promise<string | undefined> {
  // Runtime endpoint (there is no Next API route for this).
  const resp = await fetch(backendUrl("/eval/cases"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Header nur mit echtem Token; bei AUTHN_MODE=disabled anonym anfragen.
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(evalCase),
  });
  if (!resp.ok) {
    const data = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  }
  const created = (await resp.json().catch(() => null)) as { id?: string } | null;
  return created?.id;
}

async function deleteEvalCase(token: string | undefined, id: string): Promise<void> {
  const resp = await fetch(backendUrl(`/eval/cases/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  // 404: already gone — the goal of the delete is met.
  if (!resp.ok && resp.status !== 404) {
    const data = (await resp.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
  }
}

// ---------------------------------------------------------------------------
// Main Studio page
// ---------------------------------------------------------------------------

export default function StudioPage() {
  // isAuthenticated statt !!token: laedt auch bei AUTHN_MODE=disabled (kein
  // Token; Backend bedient die Operator-Plane anonym). fetchFlowList/postEvalCase
  // senden den Authorization-Header nur mit echtem Token.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [selectedFlowId, setSelectedFlowIdRaw] = useState("");
  const [builderDirty, setBuilderDirty] = useState(false);
  /** The builder's current definition, for checks that run on the canvas (Optimize). */
  const canvasDefinitionRef = useRef<(() => FlowDefinition) | null>(null);
  const getCanvasDefinition = useCallback(() => canvasDefinitionRef.current?.() ?? null, []);

  // Deep-link support: /studio?flow=<id> opens that flow (e.g. Edit/Inspect on
  // /flows); no param starts a new flow. The selection is mirrored back into
  // the address bar so a reload or a shared link reopens the same flow — but
  // only once the param has been read, so the initial empty selection doesn't
  // wipe it.
  const [urlRead, setUrlRead] = useState(false);
  // `&execution=<id>` (Live Graph → "Open in Studio") attaches that request to
  // Run & Trace for the flow it ran on.
  const [attach, setAttach] = useState<{ flowId: string; executionId: string } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const flow = params.get("flow");
    const execution = params.get("execution");
    if (flow !== null && flow !== "") {
      setSelectedFlowIdRaw(flow);
      if (execution !== null && execution !== "") setAttach({ flowId: flow, executionId: execution });
    }
    setUrlRead(true);
  }, []);
  // Drop the execution param once Run & Trace moved on (new run, clear, other flow).
  const detachExecution = useCallback(() => {
    setAttach(null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has("execution")) return;
    url.searchParams.delete("execution");
    window.history.replaceState(null, "", url.toString());
  }, []);
  useEffect(() => {
    if (attach !== null && urlRead && selectedFlowId !== attach.flowId) detachExecution();
  }, [attach, urlRead, selectedFlowId, detachExecution]);
  useEffect(() => {
    if (!urlRead || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (selectedFlowId === "") {
      if (!url.searchParams.has("flow")) return;
      url.searchParams.delete("flow");
    } else {
      if (url.searchParams.get("flow") === selectedFlowId) return;
      url.searchParams.set("flow", selectedFlowId);
    }
    window.history.replaceState(null, "", url.toString());
  }, [urlRead, selectedFlowId]);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersistentToggle(
    "studio.sidebarCollapsed",
    false,
  );
  const [focusMode, setFocusMode] = usePersistentToggle(
    "studio.focusMode",
    false,
  );
  const [paletteOpen, setPaletteOpen] = usePersistentToggle("studio.palette", true);
  const [propertiesOpen, setPropertiesOpen] = usePersistentToggle(
    "studio.properties",
    true,
  );
  const [assistOpen, setAssistOpen] = usePersistentToggle("studio.assist", true);
  // An attached request is shown in the Run & Trace bar — make sure it's visible.
  useEffect(() => {
    if (attach !== null) setAssistOpen(true);
  }, [attach, setAssistOpen]);
  const builderPanels = useMemo(
    () => ({ palette: paletteOpen, properties: propertiesOpen, assist: assistOpen }),
    [paletteOpen, propertiesOpen, assistOpen],
  );

  // Switching flows reloads the canvas — don't silently drop edits.
  const setSelectedFlowId = useCallback(
    (id: string) => {
      if (id === selectedFlowId) return;
      if (
        builderDirty &&
        !window.confirm(
          "The builder has unsaved changes. Switch flows and discard them?",
        )
      ) {
        return;
      }
      setSelectedFlowIdRaw(id);
    },
    [selectedFlowId, builderDirty],
  );

  const { data: flowList, isLoading: flowsLoading } = useQuery<
    FlowListResponse,
    Error
  >({
    queryKey: ["flows"],
    queryFn: () => fetchFlowList(token),
    enabled: ready && isAuthenticated,
  });
  const flows = flowList?.flows ?? [];
  const onlineEditing = flowList?.onlineEditing ?? false;
  const fileWriting = flowList?.fileWriting ?? false;

  const selectedFlow = flows.find((f) => f.id === selectedFlowId) ?? null;

  const evalCaseMutation = useMutation<
    string | undefined,
    Error,
    { prompt: string; flowId: string; result: PlaygroundResult; expected: string }
  >({
    mutationFn: async ({ prompt, flowId, result, expected }) => {
      if (!isAuthenticated) throw new Error("Not authenticated");

      // Build the Studio eval case (Req. 16.1)
      const newCase = buildStudioEvalCase({
        flowId,
        prompt,
        actual: result.content,
        expected,
        createdBy: "operator", // the runtime replaces it with the caller's identity when known
        tenantId: "default",
      });

      // Validate before adding to dataset (Req. 16.3)
      const validation = validateStudioEvalCase(newCase);
      if (!validation.valid) {
        const fields = validation.missingFields.join(", ");
        throw new Error(
          `Eval case created but cannot be added to dataset — missing required fields: ${fields}`,
        );
      }

      return postEvalCase(token, newCase);
    },
    // Success and failure are shown right in the Run & Trace panel.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["eval", "cases"] });
    },
  });

  const { mutateAsync: saveEvalCase } = evalCaseMutation;
  const handleSaveEvalCase = useCallback(
    (prompt: string, flowId: string, result: PlaygroundResult, expected: string) =>
      saveEvalCase({ prompt, flowId, result, expected }),
    [saveEvalCase],
  );
  const handleDeleteEvalCase = useCallback(
    async (id: string) => {
      await deleteEvalCase(token, id);
      void queryClient.invalidateQueries({ queryKey: ["eval", "cases"] });
    },
    [token, queryClient],
  );

  const handleBuilderSaved = useCallback(
    (flowId: string) => {
      void queryClient.invalidateQueries({ queryKey: ["flows"] });
      void queryClient.invalidateQueries({ queryKey: ["flow", flowId] });
      // A newly created flow becomes the selection once it shows up in the list.
      setSelectedFlowIdRaw(flowId);
    },
    [queryClient],
  );

  const showSidebar = !focusMode;

  // Node documentation follows the builder's selection.
  const catalog = useNodeTypeCatalog();
  const [inspect, setInspect] = useState<
    { nodeId: string; type: string; field?: string } | null
  >(null);
  const nodeDocs = useNodeDocs(inspect, catalog);
  const docType = nodeDocs.doc;

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden">
      {/* Page header — flow picker and layout toggles live here so the builder
          itself needs no extra header row. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2">
        <h1 className="text-base font-semibold text-foreground">Studio</h1>

        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">Flow</span>
          <FlowPicker
            flows={flows}
            value={selectedFlowId}
            onChange={setSelectedFlowId}
            loading={flowsLoading}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <PanelToggleGroup caption="Show">
            <PanelToggle
              label="Palette"
              icon={<Shapes size={13} />}
              on={paletteOpen}
              onToggle={() => setPaletteOpen((v) => !v)}
              what="the full node palette (hidden it stays as a narrow icon rail)"
            />
            <PanelToggle
              label="Properties"
              icon={<SlidersHorizontal size={13} />}
              on={propertiesOpen}
              onToggle={() => setPropertiesOpen((v) => !v)}
              what="the properties panel for the selected node/edge"
            />
            <PanelToggle
              label="Copilot & Run"
              icon={<Sparkles size={13} />}
              on={assistOpen}
              onToggle={() => setAssistOpen((v) => !v)}
              what="the Copilot and Run & Trace bars above the canvas"
            />
            <PanelToggle
              label="Sidebar"
              icon={<PanelRight size={13} />}
              on={showSidebar && !sidebarCollapsed}
              disabled={focusMode}
              onToggle={() => setSidebarCollapsed((v) => !v)}
              what="the right sidebar (Optimize, Diff, Autopilot)"
            />
          </PanelToggleGroup>
          <button
            type="button"
            onClick={() => setFocusMode((v) => !v)}
            aria-pressed={focusMode}
            title={
              focusMode
                ? "Leave focus mode — bring the sidebar back"
                : "Focus mode — hide the sidebar so the canvas gets the full width"
            }
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
              focusMode
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-foreground hover:bg-muted"
            }`}
          >
            {focusMode ? <Minimize2 size={13} aria-hidden /> : <Maximize2 size={13} aria-hidden />}
            {focusMode ? "Exit focus" : "Focus canvas"}
          </button>
        </div>
      </div>


      {/* Studio grid: Builder | Optimize on the right */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column: Builder */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden gap-0">
          {/* Builder panel */}
          <div
            className={`flex min-h-0 flex-col overflow-hidden border-b border-border bg-card p-2 ${
              "flex-1"
            }`}
          >
            {/* Builder canvas — write controls gated by operator role (Req. 21.1) */}
            <div className="flex-1 min-h-0">
              <RequireRole
                role="operator"
                mode="disable"
                fallback={
                  <div className="flex h-64 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
                    You need the <strong className="mx-1">operator</strong> role
                    to edit flows.
                  </div>
                }
              >
                <div className="h-full">
                  <StudioBuilder
                    flow={selectedFlow}
                    onSaved={handleBuilderSaved}
                    onlineEditing={onlineEditing}
                    fileWriting={fileWriting}
                    onDirtyChange={setBuilderDirty}
                    onInspect={setInspect}
                    onSaveEvalCase={handleSaveEvalCase}
                    onDeleteEvalCase={handleDeleteEvalCase}
                    panels={builderPanels}
                    canvasDefinitionRef={canvasDefinitionRef}
                    {...(attach !== null && attach.flowId === selectedFlowId
                      ? { attachExecutionId: attach.executionId, onDetachExecution: detachExecution }
                      : {})}
                  />
                </div>
              </RequireRole>
            </div>
          </div>

        </div>

        {/* Right column: node documentation (while a node is selected) +
            Optimize + Diff + Autopilot. Collapsible to a rail; the docs still
            open on their own while a node is being edited (without changing
            the saved sidebar preference) and can be dismissed per node. */}
        {(() => {
          const docsVisible = docType !== undefined && catalog !== undefined;
          const docs = docsVisible ? (
            <section className="border-b border-border pb-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Node documentation
                </span>
                <button
                  type="button"
                  onClick={nodeDocs.close}
                  title="Hide the documentation for this node"
                  aria-label="Hide node documentation"
                  className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  ×
                </button>
              </div>
              <NodeTypeDocs
                doc={docType}
                common={catalog.common}
                {...(inspect?.field ? { focusedField: inspect.field } : {})}
                {...(inspect?.nodeId ? { nodeId: inspect.nodeId } : {})}
              />
            </section>
          ) : null;

          const sidebarOpen = showSidebar && !sidebarCollapsed;
          if (!sidebarOpen && docsVisible) {
            // Docs only, shown on demand.
            return (
              <div className="w-96 shrink-0 overflow-auto border-l border-border bg-card p-4">
                {docs}
              </div>
            );
          }
          if (!showSidebar) return null;
          if (sidebarCollapsed) {
            return (
              <div className="flex w-8 shrink-0 flex-col items-center border-l border-border bg-card pt-2">
                <button type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  title="Show the sidebar (Docs, Optimize, Diff, Autopilot)"
                  aria-label="Show sidebar"
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <PanelRightOpen size={15} aria-hidden />
                </button>
                <span className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
                  Docs · Optimize · Diff · Autopilot
                </span>
              </div>
            );
          }
          return (
            <div className={`${docsVisible ? "w-96" : "w-80"} shrink-0 overflow-auto border-l border-border bg-card p-4 flex flex-col gap-6`}>
              <div className="-mb-4 flex justify-end">
                <button type="button"
                  onClick={() => setSidebarCollapsed(true)}
                  title="Hide the sidebar to give the canvas more room"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <PanelRightClose size={14} aria-hidden />
                  Hide
                </button>
              </div>
              {docs}
              {nodeDocs.hidden && (
                <button
                  type="button"
                  onClick={nodeDocs.show}
                  className="-mb-2 flex items-center gap-1.5 self-start rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <BookOpen size={13} aria-hidden />
                  Show {nodeDocs.hidden.title} node documentation
                </button>
              )}
              <OptimizePanel
                selectedFlowId={selectedFlowId}
                token={token ?? null}
                getCanvasDefinition={getCanvasDefinition}
                canvasLabel={builderDirty ? "canvas (unsaved changes)" : "canvas"}
              />

              {/* Flow Diff panel — shows draft vs. published; only meaningful
                  once an online flow has both (file flows never do). */}
              {selectedFlow?.source === "online" && selectedFlow.hasDraft && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">
                    Diff (live → draft)
                  </h3>
                  <FlowDiffPanel
                    flowId={selectedFlowId}
                    token={token ?? undefined}
                    draftMode
                  />
                </section>
              )}

              {/* Autopilot panel */}
              <section>
                <AutopilotPanel
                  flowId={selectedFlowId || undefined}
                  fixedFlow
                  limit={5}
                />
              </section>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
