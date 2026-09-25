// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Which flow edges are valid — the rules the graph compiler actually enforces
 * (`graph-engine/compile.ts`), stated once so the validator reports them
 * before a flow fails to compile, and so the Studio can refuse an invalid
 * connection while it is being drawn (the Control app mirrors this module in
 * `lib/edge-rules.ts`; a parity test keeps both in step).
 *
 *   1. A `parallel` child runs INSIDE its parallel node and is not a graph
 *      node: no edge may start or end at it.
 *   2. An agent-harness worker/verifier without an incoming edge runs inside
 *      the harness and is not a graph node: no edge may start at it. (An
 *      incoming edge makes it an ordinary step as well — allowed.)
 *   3. Unconditional edges must not form a cycle (a self-loop included) — the
 *      run would never end. A cycle through a conditional edge is fine.
 *   4. The same unconditional connection twice adds nothing.
 *   5. Every graph node must be reachable from the entry (the first node) —
 *      LangGraph refuses to compile otherwise.
 */

export interface EdgeLike {
  source: string;
  target: string;
  conditions?: string | undefined;
}

export interface NodeLike {
  id: string;
  type: string;
  parallelNodes?: Array<string | { node: string }> | undefined;
  config?: Record<string, unknown> | undefined;
}

const conditional = (e: EdgeLike): boolean => (e.conditions ?? "").trim().length > 0;
const childId = (entry: string | { node: string }): string => (typeof entry === "string" ? entry : entry.node);

/** Nodes that run inside another node (id → explanation), per the compiler's rules. */
export function inlineNodes(nodes: NodeLike[], edges: EdgeLike[]): Map<string, { kind: "parallel" | "harness"; owner: string }> {
  const out = new Map<string, { kind: "parallel" | "harness"; owner: string }>();
  for (const n of nodes) {
    if (n.type === "parallel") {
      for (const entry of n.parallelNodes ?? []) out.set(childId(entry), { kind: "parallel", owner: n.id });
    }
  }
  const targets = new Set(edges.map((e) => e.target));
  for (const n of nodes) {
    if (n.type !== "agent-harness") continue;
    const allowlist = n.config?.["allowlist"];
    const verification = n.config?.["verification"] as { target?: unknown } | undefined;
    const workers = [
      ...(Array.isArray(allowlist) ? allowlist.filter((t): t is string => typeof t === "string") : []),
      ...(typeof verification?.target === "string" ? [verification.target] : []),
    ];
    for (const w of workers) {
      if (!targets.has(w) && !out.has(w)) out.set(w, { kind: "harness", owner: n.id });
    }
  }
  return out;
}

function unconditionalPath(edges: EdgeLike[], from: string, to: string): string[] | null {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (conditional(e)) continue;
    adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
  }
  const prev = new Map<string, string>();
  const queue = [from];
  const seen = new Set([from]);
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (cur === to) {
      const path = [to];
      let p = to;
      while (p !== from) {
        p = prev.get(p) as string;
        path.unshift(p);
      }
      return path;
    }
    for (const next of adj.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      prev.set(next, cur);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Why adding `candidate` to the flow would be invalid, or null when it is
 * fine. Used while drawing a connection in the Studio.
 */
export function connectionProblem(nodes: NodeLike[], edges: EdgeLike[], candidate: EdgeLike): string | null {
  const { source, target } = candidate;
  const ids = new Set(nodes.map((n) => n.id));
  if (!ids.has(source) || !ids.has(target)) return "Both ends must be nodes of this flow.";
  const inline = inlineNodes(nodes, edges);
  for (const [end, id] of [["from", source], ["to", target]] as const) {
    const info = inline.get(id);
    if (info?.kind === "parallel") {
      return `“${id}” runs inside the parallel node “${info.owner}” (its parallelNodes), so no flow edge can go ${end} it. Remove it from “${info.owner}”'s children first.`;
    }
  }
  const worker = inline.get(source);
  if (worker?.kind === "harness") {
    return `“${source}” is a worker of the agent harness “${worker.owner}” and runs inside it — it has no outgoing flow. (An edge into it would also make it a regular step.)`;
  }
  if (!conditional(candidate)) {
    if (source === target) {
      return "A node cannot connect to itself without a condition — the run would never end. Add a condition to the edge instead.";
    }
    if (edges.some((e) => e.source === source && e.target === target && !conditional(e))) {
      return "These nodes are already connected.";
    }
    const back = unconditionalPath(edges, target, source);
    if (back) {
      return `This would close an endless loop (${[...back, target].join(" → ")}). A loop needs a condition on at least one of its edges.`;
    }
  }
  return null;
}

export interface EdgeIssue {
  path: string;
  message: string;
}

/**
 * Edge problems of a whole flow that the compiler would reject (rules 1, 2
 * and 5; cycles are reported by the validator's own cycle check).
 */
export function flowEdgeIssues(nodes: NodeLike[], edges: EdgeLike[]): EdgeIssue[] {
  const issues: EdgeIssue[] = [];
  const inline = inlineNodes(nodes, edges);
  edges.forEach((e, i) => {
    for (const [end, id] of [["starts", e.source], ["ends", e.target]] as const) {
      const info = inline.get(id);
      if (info?.kind === "parallel") {
        issues.push({
          path: `edges[${i}]`,
          message: `edge ${e.source} → ${e.target} ${end} at "${id}", which runs inside the parallel node "${info.owner}" — parallel children cannot be flow steps`,
        });
      }
    }
    const worker = inline.get(e.source);
    if (worker?.kind === "harness") {
      issues.push({
        path: `edges[${i}]`,
        message: `edge ${e.source} → ${e.target} starts at "${e.source}", a worker that runs inside the agent harness "${worker.owner}" and has no flow of its own`,
      });
    }
  });
  // Reachability from the entry (first node), over all edges.
  const graphNodes = nodes.filter((n) => !inline.has(n.id));
  const first = nodes[0];
  if (first !== undefined && graphNodes.length > 1) {
    const adj = new Map<string, string[]>();
    for (const e of edges) adj.set(e.source, [...(adj.get(e.source) ?? []), e.target]);
    const seen = new Set([first.id]);
    const queue = [first.id];
    while (queue.length > 0) {
      const cur = queue.shift() as string;
      for (const next of adj.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    nodes.forEach((n, i) => {
      if (!inline.has(n.id) && !seen.has(n.id)) {
        issues.push({
          path: `nodes[${i}](${n.id})`,
          message: `node "${n.id}" is not reachable from the start (the first node, "${first.id}") — connect it or remove it`,
        });
      }
    });
  }
  return issues;
}
