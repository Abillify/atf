"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /studio — Studio workspace route (Req. 14.1, 15.1, 16.1, 17.3, 21.1).
 *
 * Grid layout:
 *   - Builder (left/main): ReactFlow canvas + NodePropertyPanel
 *   - Run & Trace (in the builder): test the canvas or the live flow, save eval cases
 *   - Right sidebar: an accordion with one section expanded at a time —
 *     Nodes (the palette), Optimize, Diff, Autopilot and Documentation
 *
 * Write/mutation controls are gated with <RequireRole minRole="admin"> (Req. 21.1):
 * every flow write — save, publish, draft, test-run — needs `flows:write`.
 *
 * Heavy components are lazy-loaded (code-splitting, Req. 12.3).
 */

import dynamic from "next/dynamic";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { OptimizePanel } from "../../../components/OptimizePanel";
import type { FlowDefinition } from "../../../types/flow";
import { useAuth } from "../../../lib/auth/useAuth";
import { RequireRole } from "../../../lib/auth/RequireRole";
import { useConfirm } from "../../../lib/ui";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { FlowListEntry } from "../../../types/flow";
import type { PlaygroundResult } from "../../../lib/studio-run";
import { FlowPicker } from "../../../components/FlowPicker";
import { NodeTypeDocs } from "../../../components/NodeTypeDocs";
import { ResizeHandle } from "../../../components/ResizeHandle";
import { useNodeDocs } from "../../../hooks/useNodeDocs";
import { usePersistentWidth } from "../../../hooks/usePersistentWidth";
import { useNodeTypeCatalog } from "../../../lib/node-types";
import {
  validateStudioEvalCase,
  buildStudioEvalCase,
} from "../../../lib/studio-eval-case";
import { json, request } from "../../../lib/control-api";
import { usePersistentToggle } from "../../../hooks/usePersistentToggle";
import {
  PanelToggle,
  PanelToggleGroup,
} from "../../../components/PanelToggle";
import {
  BookOpen,
  ChevronDown,
  FolderInput,
  Gauge,
  GitCompare,
  Maximize2,
  Minimize2,
  RefreshCw,
  Shapes,
  SlidersHorizontal,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
import { translate } from "../../../lib/i18n";

// Lazy-load heavy components (Req. 12.3)
const FlowDiffPanel = dynamic(
  () =>
    import("../../../components/FlowDiffPanel").then((m) => m.FlowDiffPanel),
  {
    ssr: false,
    loading: () => (
      <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
        <span>{translate("studio.loadingDiff")}</span>
      </div>
    ),
  },
);

const AutopilotPanel = dynamic(
  () =>
    import("../../../components/AutopilotPanel").then((m) => m.AutopilotPanel),
  {
    ssr: false,
    loading: () => <div className="text-xs text-muted-foreground py-2">{translate("studio.loading")}</div>,
  },
);

const StudioBuilder = dynamic(
  () =>
    import("../../../components/StudioBuilder").then((m) => m.StudioBuilder),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {translate("studio.loadingBuilder")}
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

// Req 9.2: all data queries go through lib/control-api; direct
// fetch calls are no longer allowed here.
async function fetchFlowList(
  token: string | undefined,
): Promise<FlowListResponse> {
  // Header only with a real token; with AUTHN_MODE=disabled, request anonymously.
  const data = await json<
    | {
        flows?: FlowListEntry[];
        onlineEditing?: boolean;
        fileWriting?: boolean;
      }
    | FlowListEntry[]
  >("/flows", { target: "backend", token });
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
  // ControlApiError carries the backend error message ({error.message}),
  // identical to the previous behavior.
  const created = await json<{ id?: string } | undefined>("/eval/cases", {
    method: "POST",
    target: "backend",
    token,
    jsonBody: evalCase,
  });
  return created?.id;
}

async function deleteEvalCase(
  token: string | undefined,
  id: string,
): Promise<void> {
  // 404: already gone — the goal of the delete is met.
  await request(`/eval/cases/${encodeURIComponent(id)}`, {
    method: "DELETE",
    target: "backend",
    token,
  }).then(async (resp) => {
    if (!resp.ok && resp.status !== 404) {
      const data = (await resp.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(data?.error?.message ?? `HTTP ${resp.status}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Studio sidebar accordion
// ---------------------------------------------------------------------------

/**
 * One section of the Studio's right sidebar. The sidebar is an accordion:
 * exactly one section is expanded at a time (the parent owns which), the
 * others render only their header button. The header doubles as the toggle.
 */
function SidebarSection({
  id,
  current,
  onToggle,
  icon,
  title,
  children,
}: {
  id: string;
  current: string;
  onToggle: (id: string) => void;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const open = current === id;
  return (
    <section className="border-b border-border last:border-b-0">
      <h2 className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={`studio-sidebar-${id}`}
          onClick={() => onToggle(id)}
          className={`flex w-full items-center gap-2 py-2.5 text-left text-sm font-semibold transition-colors ${
            open
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <span className="text-muted-foreground">{icon}</span>
          {title}
          <ChevronDown
            size={14}
            aria-hidden
            className={`ml-auto shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>
      </h2>
      {open && (
        <div id={`studio-sidebar-${id}`} className="pb-4">
          {children}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main Studio page
// ---------------------------------------------------------------------------

export default function StudioPage() {
  // isAuthenticated instead of !!token: also loads with AUTHN_MODE=disabled (no
  // token; the backend serves the operator plane anonymously). fetchFlowList/postEvalCase
  // only send the Authorization header with a real token.
  const { token, ready, isAuthenticated } = useAuth();
  const queryClient = useQueryClient();

  const [selectedFlowId, setSelectedFlowIdRaw] = useState("");
  const [builderDirty, setBuilderDirty] = useState(false);
  /** The builder's current definition, for checks that run on the canvas (Optimize). */
  const canvasDefinitionRef = useRef<(() => FlowDefinition) | null>(null);
  const getCanvasDefinition = useCallback(
    () => canvasDefinitionRef.current?.() ?? null,
    [],
  );

  // Deep-link support: /studio?flow=<id> opens that flow (e.g. Edit/Inspect on
  // /flows); no param starts a new flow. The selection is mirrored back into
  // the address bar so a reload or a shared link reopens the same flow — but
  // only once the param has been read, so the initial empty selection doesn't
  // wipe it.
  const [urlRead, setUrlRead] = useState(false);
  // `&execution=<id>` (Live Graph → "Open in Studio") attaches that request to
  // Run & Trace for the flow it ran on.
  const [attach, setAttach] = useState<{
    flowId: string;
    executionId: string;
  } | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const flow = params.get("flow");
    const execution = params.get("execution");
    if (flow !== null && flow !== "") {
      setSelectedFlowIdRaw(flow);
      if (execution !== null && execution !== "")
        setAttach({ flowId: flow, executionId: execution });
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
    if (attach !== null && urlRead && selectedFlowId !== attach.flowId)
      detachExecution();
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
  const [propertiesOpen, setPropertiesOpen] = usePersistentToggle(
    "studio.properties",
    true,
  );
  // Right sidebar width, drag-resizable via the handle on its left edge.
  const [sidebarWidth, setSidebarWidth] = usePersistentWidth(
    "studio.sidebarWidth",
    384,
    280,
    720,
  );
  // The right sidebar is an accordion: exactly one section (Nodes, Optimize,
  // Diff, Autopilot, Documentation) is expanded, the rest stay collapsed.
  // Persisted per browser; "" = everything collapsed.
  const [sidebarSection, setSidebarSection] = useState<string>("nodes");
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(
        "atf.ui.studio.sidebarSection",
      );
      if (stored !== null) setSidebarSection(stored);
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);
  const toggleSidebarSection = useCallback((section: string) => {
    setSidebarSection((cur) => {
      const next = cur === section ? "" : section;
      try {
        window.localStorage.setItem("atf.ui.studio.sidebarSection", next);
      } catch {
        /* storage unavailable — state still applies for this session */
      }
      return next;
    });
  }, []);
  /** DOM node the builder's node palette is portalled into (Nodes section). */
  const [paletteHost, setPaletteHost] = useState<HTMLElement | null>(null);
  /** DOM node the builder's sub-flow palette is portalled into (Subflows section). */
  const [subflowsHost, setSubflowsHost] = useState<HTMLElement | null>(null);
  // Copilot and Run & Trace start hidden and are switched on individually from
  // the builder toolbar (next to Undo/Redo) — they are not permanently visible.
  const [copilotOpen, setCopilotOpen] = usePersistentToggle(
    "studio.copilot",
    false,
  );
  const [runTraceOpen, setRunTraceOpen] = usePersistentToggle(
    "studio.runTrace",
    false,
  );
  const handleTogglePanel = useCallback(
    (panel: "copilot" | "runTrace") => {
      if (panel === "copilot") setCopilotOpen((v) => !v);
      else setRunTraceOpen((v) => !v);
    },
    [setCopilotOpen, setRunTraceOpen],
  );
  // An attached request is shown in the Run & Trace bar — make sure it's visible.
  useEffect(() => {
    if (attach !== null) setRunTraceOpen(true);
  }, [attach, setRunTraceOpen]);
  const builderPanels = useMemo(
    () => ({
      // With the sidebar open the palette lives in its "Nodes" section; when
      // the sidebar is hidden the builder falls back to a narrow icon rail.
      palette: !sidebarCollapsed && !focusMode,
      properties: propertiesOpen,
      copilot: copilotOpen,
      runTrace: runTraceOpen,
    }),
    [sidebarCollapsed, focusMode, propertiesOpen, copilotOpen, runTraceOpen],
  );

  // Switching flows reloads the canvas — don't silently drop edits.
  // Req 9.5: confirmation through the dialog primitive instead of window.confirm.
  const { confirm: confirmDialog } = useConfirm();
  const setSelectedFlowId = useCallback(
    async (id: string) => {
      if (id === selectedFlowId) return;
      if (
        builderDirty &&
        !(await confirmDialog({
          title: translate("studio.unsavedChanges"),
          message:
            translate("studio.theBuilderHasUnsavedChanges"),
          confirmLabel: translate("studio.discardAndSwitch"),
          destructive: true,
        }))
      ) {
        return;
      }
      setSelectedFlowIdRaw(id);
    },
    [selectedFlowId, builderDirty, confirmDialog],
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
    {
      prompt: string;
      flowId: string;
      result: PlaygroundResult;
      expected: string;
    }
  >({
    mutationFn: async ({ prompt, flowId, result, expected }) => {
      if (!isAuthenticated) throw new Error(translate("studioPage.notAuthenticated"));

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
    (
      prompt: string,
      flowId: string,
      result: PlaygroundResult,
      expected: string,
    ) => saveEvalCase({ prompt, flowId, result, expected }),
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
  const [inspect, setInspect] = useState<{
    nodeId: string;
    type: string;
    field?: string;
  } | null>(null);
  const nodeDocs = useNodeDocs(inspect, catalog);
  const docType = nodeDocs.doc;
  const docsAvailable = docType !== undefined || nodeDocs.hidden !== undefined;
  const nodeDocsShow = nodeDocs.show;
  // Selecting a node — or focusing one of its settings — expands the
  // Documentation section so the matching passage is visible right away. The
  // key covers the focused field too: focusing another setting re-opens the
  // section (and docs the user had closed) for the field being edited.
  const inspectFocusKey =
    inspect?.nodeId !== undefined
      ? `${inspect.nodeId}:${inspect.field ?? ""}`
      : undefined;
  useEffect(() => {
    if (inspectFocusKey === undefined || !docsAvailable) return;
    nodeDocsShow();
    setSidebarSection((cur) => {
      if (cur === "documentation") return cur;
      try {
        window.localStorage.setItem(
          "atf.ui.studio.sidebarSection",
          "documentation",
        );
      } catch {
        /* storage unavailable — state still applies for this session */
      }
      return "documentation";
    });
  }, [inspectFocusKey, docsAvailable, nodeDocsShow]);
  // Where the builder's palette renders: into the sidebar's expanded Nodes
  // section; `null` while that section is collapsed (no palette anywhere);
  // `undefined` while the sidebar itself is hidden — then the builder falls
  // back to its classic rail left of the canvas.
  const sidebarOpen = showSidebar && !sidebarCollapsed;
  const paletteContainer = !sidebarOpen
    ? undefined
    : sidebarSection === "nodes"
      ? paletteHost
      : null;
  // Same for the sub-flow palette: its own "Subflows" accordion section;
  // while the sidebar is hidden it stays inside the palette's rail.
  const subflowsContainer = !sidebarOpen
    ? undefined
    : sidebarSection === "subflows"
      ? subflowsHost
      : null;
  // Sub-flows only apply to file flows with write access (mirrors the
  // builder's showFileWrite gate) — otherwise the section would be empty.
  const showSubflowsSection = fileWriting && selectedFlow?.source !== "online";

  return (
    <div className="flex h-full flex-col gap-0 overflow-hidden">
      {/* Page header — flow picker and layout toggles live here so the builder
          itself needs no extra header row. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border bg-card px-4 py-2">
        <h1 className="text-base font-semibold text-foreground">{translate("studio.studio")}</h1>

        <div className="flex min-w-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">{translate("studio.flow")}</span>
          <FlowPicker
            flows={flows}
            value={selectedFlowId}
            onChange={setSelectedFlowId}
            loading={flowsLoading}
            emptyOption="+ New flow"
            placeholder={translate("studio.newFlow")}
            ariaLabel={translate("studio.selectFlowToEditIn")}
          />
        </div>

        <div className="ml-auto flex items-center gap-2">
          <PanelToggleGroup caption={translate("studio.show")}>
            <PanelToggle
              label={translate("studio.properties")}
              icon={<SlidersHorizontal size={13} />}
              on={propertiesOpen}
              onToggle={() => setPropertiesOpen((v) => !v)}
              what="the properties panel for the selected node/edge"
            />
            <PanelToggle
              label={translate("studio.sidebar")}
              icon={<PanelRight size={13} />}
              on={showSidebar && !sidebarCollapsed}
              disabled={focusMode}
              onToggle={() => setSidebarCollapsed((v) => !v)}
              what="the right sidebar (Nodes, Optimize, Diff, Autopilot, Docs)"
            />
          </PanelToggleGroup>
          <button
            type="button"
            onClick={() => setFocusMode((v) => !v)}
            aria-pressed={focusMode}
            title={
              focusMode
                ? translate("studio.leaveFocusModeBringThe")
                : translate("studio.focusModeHideTheSidebar")
            }
            className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${
              focusMode
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-foreground hover:bg-muted"
            }`}
          >
            {focusMode ? (
              <Minimize2 size={13} aria-hidden />
            ) : (
              <Maximize2 size={13} aria-hidden />
            )}
            {focusMode ? translate("studio.exitFocus") : translate("studio.focusCanvas")}
          </button>
        </div>
      </div>

      {/* Studio grid: Builder | Optimize on the right */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left column: Builder */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden gap-0">
          {/* Builder panel */}
          <div
            className={`flex min-h-0 flex-col overflow-hidden border-b border-border bg-card p-2 ${"flex-1"}`}
          >
            {/* Builder canvas — flow writes need flows:write, i.e. the admin role (Req. 21.1) */}
            <div className="flex-1 min-h-0">
              <RequireRole
                minRole="admin"
                mode="disable"
                fallback={
                  <div className="flex h-64 items-center justify-center rounded border border-dashed border-border text-xs text-muted-foreground">
                    {translate("studio.youNeedThe")} <strong className="mx-1">admin</strong> {translate("studio.roleToEditFlows")}
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
                    onTogglePanel={handleTogglePanel}
                    paletteContainer={paletteContainer}
                    subflowsContainer={subflowsContainer}
                    canvasDefinitionRef={canvasDefinitionRef}
                    {...(attach !== null && attach.flowId === selectedFlowId
                      ? {
                          attachExecutionId: attach.executionId,
                          onDetachExecution: detachExecution,
                        }
                      : {})}
                  />
                </div>
              </RequireRole>
            </div>
          </div>
        </div>

        {/* Right column: an accordion — Nodes (the palette) and Subflows
            (both portalled from the builder), Optimize, Diff, Autopilot and
            Documentation. Exactly one section is expanded at a time, the
            others stay collapsed; the choice is remembered per browser.
            Selecting a node expands the Documentation section. Collapsible
            to a rail; while the sidebar is hidden the palette (and the
            sub-flow section inside it) falls back to the rail left of the
            canvas. */}
        {(() => {
          const docsVisible = docType !== undefined && catalog !== undefined;
          if (!sidebarOpen && docsVisible) {
            // Docs only, shown on demand.
            return (
              <>
                <ResizeHandle
                  side="left"
                  width={sidebarWidth}
                  onWidth={setSidebarWidth}
                  min={280}
                  max={720}
                  initial={384}
                  label={translate("studio.resizeTheDocumentationPanel")}
                />
                <div
                  style={{ width: sidebarWidth }}
                  className="shrink-0 overflow-auto border-l border-border bg-card p-4"
                >
                  <NodeTypeDocs
                    doc={docType}
                    common={catalog.common}
                    {...(catalog.llmFields
                      ? { llmFields: catalog.llmFields }
                      : {})}
                    {...(inspect?.field ? { focusedField: inspect.field } : {})}
                    {...(inspect?.nodeId ? { nodeId: inspect.nodeId } : {})}
                  />
                </div>
              </>
            );
          }
          if (!showSidebar) return null;
          if (sidebarCollapsed) {
            return (
              <div className="flex w-8 shrink-0 flex-col items-center border-l border-border bg-card pt-2">
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed(false)}
                  title={translate("studio.showTheSidebarNodesSubflows")}
                  aria-label={translate("studio.showSidebar")}
                  className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  <PanelRightOpen size={15} aria-hidden />
                </button>
                <span className="mt-2 text-[10px] uppercase tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
                  {translate("studio.nodesSubflowsOptimizeDiffAutopilot")}
                </span>
              </div>
            );
          }
          const hasDiff =
            selectedFlow?.source === "online" && selectedFlow.hasDraft;
          const showDocsSection = docsVisible || nodeDocs.hidden !== undefined;
          return (
            <>
              <ResizeHandle
                side="left"
                width={sidebarWidth}
                onWidth={setSidebarWidth}
                min={280}
                max={720}
                initial={384}
                label={translate("studio.resizeTheSidebar")}
              />
              <div
                style={{ width: sidebarWidth }}
                className="flex shrink-0 flex-col overflow-auto border-l border-border bg-card px-4"
              >
                <div className="flex justify-end pt-2">
                  <button
                    type="button"
                    onClick={() => setSidebarCollapsed(true)}
                    title={translate("studio.hideTheSidebarToGive")}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <PanelRightClose size={14} aria-hidden />
                    {translate("studio.hide")}
                  </button>
                </div>

                <SidebarSection
                  id="nodes"
                  current={sidebarSection}
                  onToggle={toggleSidebarSection}
                  icon={<Shapes size={13} aria-hidden />}
                  title={translate("studio.nodes")}
                >
                  {/* The builder's node palette is portalled into this element —
                    drag cards from here onto the canvas. */}
                  <div ref={setPaletteHost} />
                </SidebarSection>

                {/* Sub-flows (create / include) live in their own section — the
                  builder portals its sub-flow palette in here. Only for file
                  flows with write access, like the builder's own gate. */}
                {showSubflowsSection && (
                  <SidebarSection
                    id="subflows"
                    current={sidebarSection}
                    onToggle={toggleSidebarSection}
                    icon={<FolderInput size={13} aria-hidden />}
                    title={translate("studio.subflows")}
                  >
                    <div ref={setSubflowsHost} />
                  </SidebarSection>
                )}

                <SidebarSection
                  id="optimize"
                  current={sidebarSection}
                  onToggle={toggleSidebarSection}
                  icon={<Gauge size={13} aria-hidden />}
                  title={translate("studio.optimize")}
                >
                  <OptimizePanel
                    selectedFlowId={selectedFlowId}
                    token={token ?? null}
                    getCanvasDefinition={getCanvasDefinition}
                    canvasLabel={
                      builderDirty
                        ? translate("studio.canvasUnsavedChanges")
                        : translate("studio.canvas")
                    }
                    hideHeading
                  />
                </SidebarSection>

                {/* Flow Diff panel — shows draft vs. published; only meaningful
                  once an online flow has both (file flows never do). */}
                {hasDiff && (
                  <SidebarSection
                    id="diff"
                    current={sidebarSection}
                    onToggle={toggleSidebarSection}
                    icon={<GitCompare size={13} aria-hidden />}
                    title={translate("studio.diffLiveDraft")}
                  >
                    <FlowDiffPanel
                      flowId={selectedFlowId}
                      token={token ?? undefined}
                      draftMode
                    />
                  </SidebarSection>
                )}

                <SidebarSection
                  id="autopilot"
                  current={sidebarSection}
                  onToggle={toggleSidebarSection}
                  icon={<RefreshCw size={13} aria-hidden />}
                  title={translate("studio.autopilot")}
                >
                  <AutopilotPanel
                    flowId={selectedFlowId || undefined}
                    fixedFlow
                    limit={5}
                    hideHeading
                  />
                </SidebarSection>

                {showDocsSection && (
                  <SidebarSection
                    id="documentation"
                    current={sidebarSection}
                    onToggle={toggleSidebarSection}
                    icon={<BookOpen size={13} aria-hidden />}
                    title={translate("studio.documentation")}
                  >
                    {docsVisible ? (
                      <>
                        <div className="mb-2 flex items-center justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {translate("studio.nodeDocumentation")}
                          </span>
                          <button
                            type="button"
                            onClick={nodeDocs.close}
                            title={translate("studio.hideTheDocumentationForThis")}
                            aria-label={translate("studio.hideNodeDocumentation")}
                            className="rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            ×
                          </button>
                        </div>
                        <NodeTypeDocs
                          doc={docType}
                          common={catalog.common}
                          {...(catalog.llmFields
                            ? { llmFields: catalog.llmFields }
                            : {})}
                          {...(inspect?.field
                            ? { focusedField: inspect.field }
                            : {})}
                          {...(inspect?.nodeId
                            ? { nodeId: inspect.nodeId }
                            : {})}
                        />
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={nodeDocs.show}
                        className="flex items-center gap-1.5 self-start rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <BookOpen size={13} aria-hidden />
                        {translate("studio.showTitleNodeDocumentation", { title: nodeDocs.hidden?.title })}
                      </button>
                    )}
                  </SidebarSection>
                )}
              </div>
            </>
          );
        })()}
      </div>
    </div>
  );
}
