// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Structured flow validator (`src/graph/flow-validator.ts`)
 *
 * The dry-run validation behind the flow editor and `POST /flows/validate`.
 * Wraps the parser's schema/semantic check ({@link validateFlowDefinition})
 * with author-time checks that the runtime would otherwise only surface lazily:
 *   - routing condition expressions are grammatically valid (errors),
 *   - parallel-node children exist (errors),
 *   - classifier nodes declare a schema (errors),
 *   - referenced MCP tools are known to the platform (warnings — a tool may be
 *     wired later, so this never blocks saving),
 *   - the graph is reachable from a start edge (warning).
 *
 * Returns a machine-readable report (errors vs. warnings + path) so the editor
 * can pinpoint problems. Pure — no I/O. No `any` at module boundaries.
 */

import type { FlowDefinition } from "../types/flow.js";
import { parallelChildId, parallelChildCondition } from "../types/flow.js";
import { validateFlowDefinition } from "./flow-parser.js";
import { validateConditionExpression } from "./condition-evaluator.js";

export interface ValidationIssue {
  /** Dotted path to the offending element, e.g. "edges[2].conditions". */
  path: string;
  message: string;
}

export interface FlowValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  meta: { nodeCount: number; edgeCount: number; flowId?: string };
}

/**
 * Validates a raw flow definition. `knownToolIds` (optional) enables tool-
 * reference warnings; when omitted, tool checks are skipped.
 */
export function validateFlow(
  raw: unknown,
  knownToolIds?: ReadonlySet<string>,
): FlowValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // Stage 1: schema + core semantics (duplicate ids, edge refs, empty conds).
  const result = validateFlowDefinition(raw);
  if (!result.success) {
    return {
      valid: false,
      errors: [{ path: "$", message: result.error.reason }],
      warnings: [],
      meta: {
        nodeCount: countNodes(raw),
        edgeCount: countEdges(raw),
        ...(typeof (raw as { id?: unknown })?.id === "string"
          ? { flowId: (raw as { id: string }).id }
          : {}),
      },
    };
  }

  const flow: FlowDefinition = result.data;
  const nodeIds = new Set(flow.nodes.map((n) => n.id));

  // Routing condition expressions must parse.
  flow.edges.forEach((edge, i) => {
    if (edge.conditions !== undefined && edge.conditions.trim().length > 0) {
      const v = validateConditionExpression(edge.conditions);
      if (!v.valid) {
        errors.push({
          path: `edges[${i}].conditions`,
          message: `Invalid routing expression: ${v.error}`,
        });
      }
    }
  });

  // Node-level checks.
  flow.nodes.forEach((node, i) => {
    // classifier nodes need a schema.
    if (node.type === "classifier" && node.classifierSchema === undefined) {
      errors.push({
        path: `nodes[${i}](${node.id})`,
        message: `classifier node "${node.id}" is missing classifierSchema`,
      });
    }
    // parallel children must exist and not self-reference.
    if (node.type === "parallel") {
      const children = node.parallelNodes ?? [];
      const ragProfiles = (node.config as { ragProfiles?: unknown } | undefined)
        ?.ragProfiles as
        | {
            select?: Array<{ when?: unknown; use?: unknown }>;
            default?: unknown;
            shared?: Array<{ when?: unknown }>;
            profiles?: Record<string, Array<{ when?: unknown }>>;
          }
        | undefined;
      // A parallel node does real work via either static children or a
      // data-driven ragProfiles plan; warn only when it has neither.
      if (children.length === 0 && ragProfiles === undefined) {
        warnings.push({
          path: `nodes[${i}](${node.id})`,
          message: `parallel node "${node.id}" has no parallelNodes and no ragProfiles`,
        });
      }
      for (const entry of children) {
        const childId = parallelChildId(entry);
        if (!nodeIds.has(childId)) {
          errors.push({
            path: `nodes[${i}](${node.id}).parallelNodes`,
            message: `parallel node "${node.id}" references unknown child "${childId}"`,
          });
        } else if (childId === node.id) {
          errors.push({
            path: `nodes[${i}](${node.id}).parallelNodes`,
            message: `parallel node "${node.id}" cannot reference itself`,
          });
        }
        const childCondition = parallelChildCondition(entry);
        if (childCondition !== undefined && childCondition.trim().length > 0) {
          const res = validateConditionExpression(childCondition);
          if (!res.valid) {
            errors.push({
              path: `nodes[${i}](${node.id}).parallelNodes`,
              message: `parallel node "${node.id}" child "${childId}" has an invalid condition: ${res.error}`,
            });
          }
        }
      }
      // ragProfiles: select/source `when` expressions must parse, and every
      // referenced profile (select.use / default) must be defined.
      if (ragProfiles !== undefined) {
        const profileNames = new Set(
          ragProfiles.profiles !== undefined
            ? Object.keys(ragProfiles.profiles)
            : [],
        );
        for (const [s, rule] of (ragProfiles.select ?? []).entries()) {
          if (typeof rule.when === "string" && rule.when.trim().length > 0) {
            const res = validateConditionExpression(rule.when);
            if (!res.valid) {
              errors.push({
                path: `nodes[${i}](${node.id}).config.ragProfiles.select[${s}].when`,
                message: `invalid profile-select condition: ${res.error}`,
              });
            }
          }
          if (typeof rule.use === "string" && !profileNames.has(rule.use)) {
            errors.push({
              path: `nodes[${i}](${node.id}).config.ragProfiles.select[${s}].use`,
              message: `parallel node "${node.id}" select rule references unknown profile "${rule.use}"`,
            });
          }
        }
        if (
          typeof ragProfiles.default === "string" &&
          !profileNames.has(ragProfiles.default)
        ) {
          errors.push({
            path: `nodes[${i}](${node.id}).config.ragProfiles.default`,
            message: `parallel node "${node.id}" default references unknown profile "${ragProfiles.default}"`,
          });
        }
        // Validate every source `when` across shared + all profiles.
        const allSourceLists: Array<{
          label: string;
          list?: Array<{ when?: unknown }>;
        }> = [
          { label: "shared", list: ragProfiles.shared },
          ...Object.entries(ragProfiles.profiles ?? {}).map(([name, list]) => ({
            label: `profiles.${name}`,
            list,
          })),
        ];
        for (const { label, list } of allSourceLists) {
          for (const [s, item] of (list ?? []).entries()) {
            const when = item.when;
            if (typeof when === "string" && when.trim().length > 0) {
              const res = validateConditionExpression(when);
              if (!res.valid) {
                errors.push({
                  path: `nodes[${i}](${node.id}).config.ragProfiles.${label}[${s}].when`,
                  message: `invalid source condition: ${res.error}`,
                });
              }
            }
          }
        }
      }
    }
    // Tool references unknown to the platform → warning (may be wired later).
    if (knownToolIds !== undefined && knownToolIds.size > 0 && node.tools) {
      for (const toolRef of node.tools) {
        if (!knownToolIds.has(toolRef)) {
          warnings.push({
            path: `nodes[${i}](${node.id}).tools`,
            message: `tool "${toolRef}" is not known to any connected MCP server`,
          });
        }
      }
    }
  });

  // Reachability: at least one edge must originate from start (or a single node
  // flow with no edges runs the first node implicitly).
  if (flow.edges.length > 0) {
    const hasStart = flow.edges.some(
      (e) => e.source === "__start__" || !nodeIds.has(e.source),
    );
    const targets = new Set(flow.edges.map((e) => e.target));
    const reachable =
      hasStart || flow.nodes.some((n) => targets.has(n.id) === false);
    if (!reachable) {
      warnings.push({
        path: "edges",
        message:
          "no explicit start edge and every node is an edge target — entry point is ambiguous (the first node is used)",
      });
    }
  }

  // Cycle detection: detect directed cycles using DFS (Tarjan-like).
  // Only non-conditional edges are considered for hard cycles since conditional
  // edges may never be taken at runtime. Reports all cycles found.
  const cycleErrors = detectCycles(flow);
  for (const cycle of cycleErrors) {
    errors.push(cycle);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    meta: {
      nodeCount: flow.nodes.length,
      edgeCount: flow.edges.length,
      flowId: flow.id,
    },
  };
}

function countNodes(raw: unknown): number {
  const nodes = (raw as { nodes?: unknown })?.nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function countEdges(raw: unknown): number {
  const edges = (raw as { edges?: unknown })?.edges;
  return Array.isArray(edges) ? edges.length : 0;
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS with coloring)
// ---------------------------------------------------------------------------

/**
 * Detects directed cycles in the flow graph using depth-first search.
 * Only unconditional edges are followed — conditional edges are routing hints
 * that may never execute, so a "cycle" through them is not necessarily a
 * deadlock. Hard cycles (unconditional back-edges) ARE always bugs.
 *
 * Returns one ValidationIssue per detected cycle describing the path.
 */
function detectCycles(flow: FlowDefinition): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Build adjacency list from unconditional edges only.
  const adj = new Map<string, string[]>();
  for (const node of flow.nodes) {
    adj.set(node.id, []);
  }
  for (const edge of flow.edges) {
    // Skip explicitly conditional edges (they have a non-empty conditions field).
    const hasCondition =
      edge.conditions !== undefined && edge.conditions.trim().length > 0;
    if (hasCondition) continue;
    // Skip __end__ / __start__ pseudo-nodes.
    const sourceId = edge.source;
    const targetId = edge.target;
    const sourceAdj = adj.get(sourceId);
    if (sourceAdj === undefined || !adj.has(targetId)) continue;
    sourceAdj.push(targetId);
  }

  // 0 = unvisited, 1 = in-progress (on stack), 2 = done
  const color = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string | undefined>();
  for (const node of flow.nodes) color.set(node.id, 0);

  const reconstructPath = (start: string, end: string): string => {
    const path: string[] = [end];
    let cur: string | undefined = end;
    while (cur !== start && cur !== undefined) {
      cur = parent.get(cur);
      if (cur !== undefined) path.unshift(cur);
    }
    return path.join(" → ");
  };

  const dfs = (nodeId: string): void => {
    color.set(nodeId, 1);
    for (const neighbor of adj.get(nodeId) ?? []) {
      const c = color.get(neighbor) ?? 0;
      if (c === 1) {
        // Back-edge found — cycle detected.
        const cyclePath = `${reconstructPath(neighbor, nodeId)} → ${neighbor}`;
        issues.push({
          path: "edges",
          message: `Cycle detected in unconditional edges: ${cyclePath}. Cycles cause infinite loops at runtime. Add a conditional edge or a router node to break the cycle.`,
        });
      } else if (c === 0) {
        parent.set(neighbor, nodeId);
        dfs(neighbor);
      }
    }
    color.set(nodeId, 2);
  };

  for (const node of flow.nodes) {
    if ((color.get(node.id) ?? 0) === 0) {
      dfs(node.id);
    }
  }

  return issues;
}
