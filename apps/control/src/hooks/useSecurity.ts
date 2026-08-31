"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback, useRef } from "react";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";
import type {
  RedTeamRun,
  RedTeamRunSummary,
  AttackInfo,
  PostureResponse,
  ToolAuthzPolicyView,
  McpServerInfo,
} from "../types/security";

export interface UseSecurityOptions {
  enabled?: boolean;
  token?: string;
  /** Poll interval for runs + posture in ms. Default 5000. */
  intervalMs?: number;
}

export interface UseSecurityResult {
  posture: PostureResponse | null;
  runs: RedTeamRunSummary[];
  attacks: AttackInfo[];
  toolAuthz: ToolAuthzPolicyView | null;
  mcp: McpServerInfo | null;
  redTeamEnabled: boolean;
  isLoading: boolean;
  error: string | null;
  /** Trigger a red-team run against a flow; resolves to the full run or null. */
  runRedTeam: (flowId: string) => Promise<RedTeamRun | null>;
  /** Fetch a single run's full detail (all trials). */
  getRun: (runId: string) => Promise<RedTeamRun | null>;
  /** Persist an edited tool-authorization policy. Resolves the new view or an error string. */
  saveToolAuthz: (policy: {
    rules: ToolAuthzPolicyView["rules"];
    defaultAction: "allow" | "deny";
  }) => Promise<
    { ok: true; policy: ToolAuthzPolicyView } | { ok: false; error: string }
  >;
  /** True while a manual run is in flight. */
  isRunning: boolean;
  refresh: () => void;
}

/**
 * Aggregates the `/security/*` endpoints for the dashboard's Security tab:
 * posture score, run history, attack library, tool-authz policy, and the list
 * of flows exposed as MCP tools. Polls posture + runs; the static data
 * (attacks, tool-authz, mcp) is fetched once and on manual refresh.
 */
export function useSecurity(options?: UseSecurityOptions): UseSecurityResult {
  const enabled = options?.enabled ?? true;
  const token = options?.token;
  const intervalMs = options?.intervalMs ?? 5000;

  const [posture, setPosture] = useState<PostureResponse | null>(null);
  const [runs, setRuns] = useState<RedTeamRunSummary[]>([]);
  const [attacks, setAttacks] = useState<AttackInfo[]>([]);
  const [toolAuthz, setToolAuthz] = useState<ToolAuthzPolicyView | null>(null);
  const [mcp, setMcp] = useState<McpServerInfo | null>(null);
  const [redTeamEnabled, setRedTeamEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const isVisible = useDocumentVisibility();

  const tokenRef = useRef(token);
  tokenRef.current = token;

  const getJson = useCallback(async <T>(path: string): Promise<T | null> => {
    const res = await authFetch(backendUrl(path), tokenRef.current, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }, []);

  // Static data — fetched once (and on refresh): attacks, tool-authz, mcp.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const [att, ta, m] = await Promise.all([
          getJson<{ attacks: AttackInfo[] }>("/security/red-team/attacks"),
          getJson<ToolAuthzPolicyView>("/security/tool-authz"),
          getJson<McpServerInfo>("/security/mcp"),
        ]);
        if (cancelled) return;
        if (att) setAttacks(att.attacks);
        if (ta) setToolAuthz(ta);
        if (m) setMcp(m);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof Error ? err.message : "security fetch failed",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
    // The flagged "attacks" below is `att.attacks` (from the
    // `getJson<{ attacks: ... }>` generic type argument above), not the
    // `attacks` state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the type argument's property
    // name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, nonce, getJson]);

  // Polled data — posture + runs.
  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const [p, r] = await Promise.all([
          getJson<PostureResponse>("/security/red-team/posture"),
          getJson<{ runs: RedTeamRunSummary[]; enabled?: boolean }>(
            "/security/red-team/runs",
          ),
        ]);
        if (cancelled) return;
        if (p) {
          setPosture(p);
          setRedTeamEnabled(p.enabled);
        }
        if (r) setRuns(r.runs);
        setError(null);
        setIsLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "security fetch failed",
          );
          setIsLoading(false);
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // The flagged "runs" below is `r.runs` (from the
    // `getJson<{ runs: ... }>` generic type argument above), not the `runs`
    // state. @babel/eslint-parser has no TypeScript type info, so
    // exhaustive-deps' scope analysis can't tell the type argument's property
    // name apart from the same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, isVisible, nonce, getJson]);

  const runRedTeam = useCallback(
    async (flowId: string): Promise<RedTeamRun | null> => {
      setIsRunning(true);
      try {
        const res = await authFetch(
          backendUrl(`/security/red-team/${encodeURIComponent(flowId)}/run`),
          tokenRef.current,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          },
        );
        setNonce((n) => n + 1);
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          setError(detail?.error?.message ?? `HTTP ${res.status}`);
          return null;
        }
        return (await res.json()) as RedTeamRun;
      } catch (err) {
        setError(err instanceof Error ? err.message : "red-team run failed");
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    // The flagged "error" below is `detail?.error` (from the
    // `as { error?: ... } | null` cast above), not the `error` state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell the cast's property name apart from the
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const getRun = useCallback(
    async (runId: string): Promise<RedTeamRun | null> => {
      try {
        return await getJson<RedTeamRun>(
          `/security/red-team/runs/${encodeURIComponent(runId)}`,
        );
      } catch {
        return null;
      }
    },
    [getJson],
  );

  const saveToolAuthz = useCallback(
    async (policy: {
      rules: ToolAuthzPolicyView["rules"];
      defaultAction: "allow" | "deny";
    }): Promise<
      { ok: true; policy: ToolAuthzPolicyView } | { ok: false; error: string }
    > => {
      try {
        const res = await authFetch(
          backendUrl("/security/tool-authz"),
          tokenRef.current,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(policy),
          },
        );
        if (!res.ok) {
          const detail = (await res.json().catch(() => null)) as {
            error?: { message?: string };
          } | null;
          return {
            ok: false,
            error: detail?.error?.message ?? `HTTP ${res.status}`,
          };
        }
        const updated = (await res.json()) as ToolAuthzPolicyView;
        setToolAuthz(updated);
        return { ok: true, policy: updated };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : "save failed",
        };
      }
    },
    // The flagged "error" below is the `error` property key of this
    // function's own return objects (`{ ok: false, error: ... }`), not the
    // `error` state — this callback never reads or sets that state.
    // @babel/eslint-parser has no TypeScript type info, so exhaustive-deps'
    // scope analysis can't tell an object property key apart from a
    // same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  return {
    posture,
    runs,
    attacks,
    toolAuthz,
    mcp,
    redTeamEnabled,
    isLoading,
    error,
    runRedTeam,
    getRun,
    saveToolAuthz,
    isRunning,
    refresh,
  };
}
