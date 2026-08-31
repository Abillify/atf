"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import React, { useState, useRef, useMemo } from "react";
import { Button } from "../lib/ui";
import { FlowCanvas } from "./FlowCanvas";
import { NodePropertyPanel, type EdgeSelection } from "./NodePropertyPanel";
import { FlowVersionsPanel } from "./FlowVersionsPanel";
import {
  flowToGraph,
  graphToFlow,
  makeNode,
  autoPosition,
  type RFNode,
  type RFEdge,
} from "../lib/flow-graph";
import type {
  FlowDefinition,
  FlowDetail,
  FlowValidationReport,
  NodeType,
} from "../types/flow";
import type { useFlows } from "../hooks/useFlows";

export interface FlowEditorProps {
  detail: FlowDetail;
  actions: ReturnType<typeof useFlows>;
  onBack: () => void;
}

const NODE_TYPES: NodeType[] = [
  "llm",
  "tool",
  "router",
  "classifier",
  "parallel",
  "retrieval",
  "memory",
];

function download(name: string, content: string): void {
  const blob = new Blob([content], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export function FlowEditor({
  detail,
  actions,
  onBack,
}: FlowEditorProps): React.JSX.Element {
  const source = detail.draft ?? detail.published;
  const editable = detail.editable;

  const initial = useMemo(
    () =>
      source ??
      ({
        id: detail.id,
        name: detail.id,
        nodes: [],
        edges: [],
      } as FlowDefinition),
    [source, detail.id],
  );
  const [base, setBase] = useState<FlowDefinition>(initial);
  const initialGraph = useMemo(() => flowToGraph(initial), [initial]);
  const [nodes, setNodes] = useState<RFNode[]>(initialGraph.nodes);
  const [edges, setEdges] = useState<RFEdge[]>(initialGraph.edges);
  const [selNode, setSelNode] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [report, setReport] = useState<FlowValidationReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showVersions, setShowVersions] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const current = (): FlowDefinition => graphToFlow(base, nodes, edges);

  const addNode = (type: NodeType): void => {
    const node = makeNode(
      type,
      nodes.map((n) => n.id),
    );
    setNodes((ns) => [
      ...ns,
      {
        id: node.id,
        type: "flowNode",
        position: autoPosition(ns.length),
        data: { flowNode: node },
      },
    ]);
    setSelNode(node.id);
    setSelEdge(null);
  };

  const updateNode = (updated: FlowDefinition["nodes"][number]): void => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === updated.id ? { ...n, data: { flowNode: updated } } : n,
      ),
    );
  };

  const deleteNode = (id: string): void => {
    setNodes((ns) => ns.filter((n) => n.id !== id));
    setEdges((es) => es.filter((e) => e.source !== id && e.target !== id));
    setSelNode(null);
  };

  const updateEdge = (sel: EdgeSelection): void => {
    setEdges((es) =>
      es.map((e) =>
        e.id === sel.id
          ? {
              ...e,
              label: sel.label || undefined,
              data: { conditions: sel.conditions || undefined },
            }
          : e,
      ),
    );
  };

  const deleteEdge = (id: string): void => {
    setEdges((es) => es.filter((e) => e.id !== id));
    setSelEdge(null);
  };

  const doValidate = async (): Promise<FlowValidationReport> => {
    const r = await actions.validate(current());
    setReport(r);
    return r;
  };

  const doSave = async (): Promise<void> => {
    setStatus("Saving…");
    try {
      const { validation } = await actions.saveDraft(detail.id, current());
      setReport(validation);
      setStatus(validation.valid ? "Draft saved" : "Draft saved (has issues)");
    } catch (e) {
      setStatus(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doPublish = async (): Promise<void> => {
    setStatus("Publishing…");
    // Save the current graph as draft first so publish acts on it.
    try {
      await actions.saveDraft(detail.id, current());
    } catch {
      /* surfaced below */
    }
    const res = await actions.publish(detail.id);
    if ("error" in res) {
      if (res.validation) setReport(res.validation);
      setStatus(`Publish blocked: ${res.error}`);
    } else {
      setReport(res.validation);
      setStatus("Published — live now");
    }
  };

  const cloneToOnline = async (): Promise<void> => {
    setStatus("Creating online draft…");
    try {
      await actions.saveDraft(detail.id, current());
      setStatus("Online draft created — reopen from the list to edit");
    } catch (e) {
      setStatus(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const doDelete = async (): Promise<void> => {
    if (
      !window.confirm(
        `Delete flow "${detail.id}"? This removes its draft, published version and history.`,
      )
    ) {
      return;
    }
    setStatus("Deleting…");
    const ok = await actions.remove(detail.id);
    if (ok) {
      onBack();
    } else {
      setStatus("Delete failed.");
    }
  };

  const onImport = (file: File): void => {
    void file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as FlowDefinition;
        const g = flowToGraph(parsed);
        setBase({ ...parsed, id: detail.id });
        setNodes(g.nodes);
        setEdges(g.edges);
        setStatus("Imported into editor (not yet saved)");
      } catch {
        setStatus("Import failed: invalid JSON");
      }
    });
  };

  const selectedFlowNode =
    nodes.find((n) => n.id === selNode)?.data.flowNode ?? null;
  const selectedEdge: EdgeSelection | null = (() => {
    const e = edges.find((x) => x.id === selEdge);
    if (e === undefined) return null;
    return {
      id: e.id,
      conditions: e.data.conditions ?? "",
      label: e.label ?? "",
    };
  })();

  if (showVersions) {
    return (
      <FlowVersionsPanel
        flowId={detail.id}
        editable={editable}
        actions={actions}
        onClose={() => setShowVersions(false)}
        onRolledBack={onBack}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
        <Button variant="outline" size="sm" onClick={onBack}>
          ← Flows
        </Button>
        <span className="font-mono text-sm font-semibold text-foreground">
          {base.id}
        </span>
        <span className="rounded bg-muted px-1.5 text-[10px] uppercase text-muted-foreground">
          {detail.source}
          {editable ? "" : " · read-only"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {editable && (
            <>
              <select
                onChange={(e) => {
                  if (e.target.value) {
                    addNode(e.target.value as NodeType);
                    e.target.value = "";
                  }
                }}
                defaultValue=""
                aria-label="Add node"
                className="rounded border border-border px-2 py-1 text-xs"
              >
                <option value="">+ Add node…</option>
                {NODE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <Button variant="outline" size="sm" onClick={() => void doValidate()}>
                Validate
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void doSave()}>
                Save draft
              </Button>
              <Button variant="primary" size="sm" onClick={() => void doPublish()}>
                Publish
              </Button>
            </>
          )}
          {!editable && actions.onlineEditing && (
            <Button variant="secondary" size="sm" onClick={() => void cloneToOnline()}>
              Edit online (clone)
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              download(`${base.id}.json`, JSON.stringify(current(), null, 2))
            }
          >
            Export
          </Button>
          {actions.onlineEditing && detail.source === "online" && (
            <Button variant="outline" size="sm" onClick={() => setShowVersions(true)}>
              Versions
            </Button>
          )}
          {editable && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileInput.current?.click()}
              >
                Import
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onImport(f);
                  e.target.value = "";
                }}
              />
              {detail.source === "online" && (
                <Button variant="destructive" size="sm" onClick={() => void doDelete()}>
                  Delete
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      {status && <div className="mt-2 text-xs text-muted-foreground">{status}</div>}

      {/* Validation report */}
      {report && (report.errors.length > 0 || report.warnings.length > 0) && (
        <div className="mt-2 space-y-1 rounded border border-border bg-muted p-2 text-xs">
          {report.errors.map((e, i) => (
            <div key={`e${i}`} className="text-red-600">
              ✗ <span className="font-mono">{e.path}</span>: {e.message}
            </div>
          ))}
          {report.warnings.map((w, i) => (
            <div key={`w${i}`} className="text-amber-600">
              ⚠ <span className="font-mono">{w.path}</span>: {w.message}
            </div>
          ))}
        </div>
      )}

      {/* Canvas + property panel */}
      <div className="mt-3 flex flex-1 gap-3 overflow-hidden">
        <div className="flex-1">
          <FlowCanvas
            nodes={nodes}
            edges={edges}
            editable={editable}
            onNodesChange={setNodes}
            onEdgesChange={setEdges}
            onSelectionChange={(nodeIds, edgeIds) => {
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
            }}
          />
        </div>
        {editable && (
          <aside className="w-72 shrink-0 overflow-auto rounded-lg border border-border bg-card p-3">
            <NodePropertyPanel
              node={selectedFlowNode}
              edge={selectedEdge}
              onNodeChange={updateNode}
              onDeleteNode={deleteNode}
              onEdgeChange={updateEdge}
              onDeleteEdge={deleteEdge}
            />
          </aside>
        )}
      </div>
    </div>
  );
}
