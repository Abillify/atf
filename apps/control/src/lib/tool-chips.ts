// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Tool chips: the tools a node offers its model (`tools:` in the flow), drawn
 * as a row of small cards docked to the node's right on the Studio canvas,
 * and matched against the tool calls of the traced run.
 *
 * The runtime names a tool call after its AI SDK tool key, not after the
 * reference in the flow: `server/tool` becomes `server__tool` (characters
 * outside `[A-Za-z0-9_-]` replaced by `_`, at most 64 chars, a numeric suffix
 * on collision — see runtime `graph/agent-tools.ts` `uniqueToolKey`). A ref
 * without a server part uses the ref for both halves. Calls that match no
 * declared ref (patterns resolved differently, built-in tools such as
 * `select_tools`) get a chip of their own, so every call of the run is shown.
 */

import type { NodeState } from "../components/graph/graphUtils";

export type ToolChipStatus = "idle" | "running" | "completed" | "error";

export interface ToolChip {
  /** Stable React key. */
  key: string;
  /** What the chip shows: the ref from the flow, or the called tool's name. */
  name: string;
  /** Declared in the node's `tools:` (false: only seen in the run). */
  declared: boolean;
  status: ToolChipStatus;
  /** Calls of this tool in the traced run. */
  calls: number;
  /** Of which failed. */
  errors: number;
  /** Latency of the last finished call. */
  lastLatencyMs?: number;
  /** Argument keys fixed in `config.toolArgs` for this tool. */
  staticArgs: string[];
}

const sanitize = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, "_");

/** Server and tool part of a ref, split like the runtime does. */
function splitRef(ref: string): { server: string; bare: string } {
  const parts = ref.split("/");
  return parts.length >= 2
    ? { server: parts[0] ?? ref, bare: parts.slice(1).join("/") }
    : { server: ref, bare: ref };
}

/** Whether a tool call named `callName` is an invocation of the flow's `ref`. */
export function matchesToolRef(ref: string, callName: string): boolean {
  if (callName === ref || callName === sanitize(ref)) return true;
  const { server, bare } = splitRef(ref);
  const star = bare.indexOf("*");
  if (star >= 0) {
    // Pattern (`server/*`, `server/get_*`): any tool of that server with the prefix.
    return callName.startsWith(`${sanitize(server)}__${sanitize(bare.slice(0, star))}`);
  }
  const key = `${sanitize(server)}__${sanitize(bare)}`.slice(0, 64);
  if (callName === key) return true;
  // Collision suffix `_2`, `_3`, … (the key is shortened to fit 64 chars).
  const m = /^(.*)(_\d+)$/.exec(callName);
  return m !== null && m[1] === key.slice(0, 64 - (m[2]?.length ?? 0));
}

type Aggregate = Pick<ToolChip, "status" | "calls" | "errors" | "lastLatencyMs"> & { lastSequence: number };

function aggregate(calls: NodeState[]): Aggregate {
  const last = calls[calls.length - 1];
  if (last === undefined) return { status: "idle", calls: 0, errors: 0, lastSequence: -1 };
  const errors = calls.filter((c) => c.status === "error").length;
  const finished = calls.filter((c) => c.status !== "running" && c.latency_ms != null);
  const lastLatency = finished[finished.length - 1]?.latency_ms;
  return {
    status: calls.some((c) => c.status === "running")
      ? "running"
      : last.status === "error"
        ? "error"
        : "completed",
    calls: calls.length,
    errors,
    lastSequence: last.sequence ?? 0,
    ...(lastLatency != null ? { lastLatencyMs: lastLatency } : {}),
  };
}

/** Keys of the arguments fixed for `ref` in `config.toolArgs` (none: the model decides all). */
export function staticArgKeys(toolArgs: unknown, ref: string): string[] {
  if (toolArgs === null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) return [];
  const args = (toolArgs as Record<string, unknown>)[ref];
  return args !== null && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
}

/** Running first, then tools the run called (latest call first), then the rest in flow order. */
const statusRank = (a: Aggregate): number => (a.status === "running" ? 0 : a.calls > 0 ? 1 : 2);

/**
 * The chips of one node: its declared tools, plus the tools the run called
 * that none of them covers. `calls` are the run's synthetic tool states issued
 * by this node (`kind: "tool"`, `parent_node_id` = the node). Tools that are
 * running or ran come first, so they stay in view in a scrolled column; the
 * others keep their flow order. `toolArgs` is the node's `config.toolArgs`.
 */
export function toolChipsFor(
  tools: readonly string[] | undefined,
  calls: readonly NodeState[],
  toolArgs?: unknown,
): ToolChip[] {
  const ordered = [...calls].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  const refs = [...new Set(tools ?? [])];
  const byRef = new Map<string, NodeState[]>(refs.map((r) => [r, []]));
  const extra = new Map<string, NodeState[]>();
  for (const call of ordered) {
    const ref = refs.find((r) => matchesToolRef(r, call.label));
    if (ref !== undefined) byRef.get(ref)?.push(call);
    else extra.set(call.label, [...(extra.get(call.label) ?? []), call]);
  }
  const all = [
    ...refs.map((r) => ({
      key: `ref:${r}`,
      name: r,
      declared: true,
      staticArgs: staticArgKeys(toolArgs, r),
      agg: aggregate(byRef.get(r) ?? []),
    })),
    ...[...extra].map(([name, cs]) => ({
      key: `call:${name}`,
      name,
      declared: false,
      staticArgs: [] as string[],
      agg: aggregate(cs),
    })),
  ];
  // Array.prototype.sort is stable: equal ranks keep the flow order.
  all.sort(
    (a, b) =>
      statusRank(a.agg) - statusRank(b.agg) || (statusRank(a.agg) < 2 ? b.agg.lastSequence - a.agg.lastSequence : 0),
  );
  return all.map(({ agg: { lastSequence: _seq, ...agg }, ...chip }) => ({ ...chip, ...agg }));
}

/** Synthetic tool states of a run, grouped by the node that issued them. */
export function toolCallsByParent(states: Map<string, NodeState> | undefined): Map<string, NodeState[]> {
  const out = new Map<string, NodeState[]>();
  for (const s of states?.values() ?? []) {
    if (s.kind !== "tool" || !s.parent_node_id) continue;
    out.set(s.parent_node_id, [...(out.get(s.parent_node_id) ?? []), s]);
  }
  return out;
}

/** Gap between a node and its tool column. */
export const TOOL_RAIL_GAP = 36;
/** Chip geometry — the canvas renders the column at exactly this size, so the
 * space the layout reserves is the space it takes. */
export const TOOL_CHIP_H = 22;
export const TOOL_CHIP_GAP = 4;
/** Padding + border of the column around its chips. */
export const TOOL_RAIL_INSET = 5;
const CHIP_MIN_W = 96;
const CHIP_MAX_W = 220;
/** Icon, paddings, the static-arguments mark and the call badge around the name. */
const CHIP_CHROME_W = 70;
/** Chips shown before the column scrolls. */
export const TOOL_RAIL_VISIBLE = 6;
/** Room for the scroll bar of a scrolling column. */
const SCROLLBAR_W = 8;
/** Width of one character of the chip's 10px monospace name. */
const CHIP_CHAR_W = 6.1;

/**
 * Size of a node's tool column (chips stacked top to bottom): one width for
 * all chips, from the longest name (longer names are truncated at the cap).
 * Above {@link TOOL_RAIL_VISIBLE} chips the column keeps its height and
 * scrolls; half a chip peeks out at the bottom so that shows.
 */
export function toolRailSize(names: readonly string[]): { width: number; height: number; scrolls: boolean } {
  if (names.length === 0) return { width: 0, height: 0, scrolls: false };
  const longest = Math.max(...names.map((n) => n.length));
  const chipW = Math.round(Math.min(CHIP_MAX_W, Math.max(CHIP_MIN_W, CHIP_CHROME_W + CHIP_CHAR_W * longest)));
  const scrolls = names.length > TOOL_RAIL_VISIBLE;
  const rows = scrolls ? TOOL_RAIL_VISIBLE + 0.5 : names.length;
  return {
    width: chipW + 2 * TOOL_RAIL_INSET + (scrolls ? SCROLLBAR_W : 0),
    height: Math.round(rows * TOOL_CHIP_H + (Math.ceil(rows) - 1) * TOOL_CHIP_GAP + 2 * TOOL_RAIL_INSET),
    scrolls,
  };
}
