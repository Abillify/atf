"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

import { useState, useEffect, useCallback } from "react";
import type {
  FlowDefinition,
  FlowListEntry,
  FlowDetail,
  FlowValidationReport,
  FlowVersionEntry,
  FlowDiffResponse,
} from "../types/flow";
import { backendUrl } from "../lib/backend-url";
import { authFetch } from "../lib/auth-fetch";
import { useDocumentVisibility } from "./useDocumentVisibility";

export interface UseFlowsOptions {
  baseUrl?: string;
  intervalMs?: number;
  enabled?: boolean;
  token?: string;
}

export interface UseFlowsResult {
  flows: FlowListEntry[];
  onlineEditing: boolean;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
  get: (id: string) => Promise<FlowDetail>;
  validate: (def: FlowDefinition) => Promise<FlowValidationReport>;
  saveDraft: (
    id: string,
    def: FlowDefinition,
  ) => Promise<{ validation: FlowValidationReport }>;
  publish: (
    id: string,
  ) => Promise<
    | { validation: FlowValidationReport }
    | { error: string; validation?: FlowValidationReport }
  >;
  remove: (id: string) => Promise<boolean>;
  listVersions: (id: string) => Promise<FlowVersionEntry[]>;
  rollback: (id: string, version: number) => Promise<boolean>;
  diff: (
    id: string,
    params?: { from?: number; to?: number; draft?: boolean },
  ) => Promise<FlowDiffResponse | null>;
  /**
   * Structural diff between two arbitrary endpoints (any flow/draft
   * combination) via GET /flows/diff/compare — powers the /flow-diff page.
   */
  compare: (params: {
    from: string;
    fromDraft?: string;
    to: string;
    toDraft?: string;
  }) => Promise<FlowDiffResponse>;
}

function backendBase(): string {
  return backendUrl("");
}

/** Manages the flow list and all `/flows` mutations for the editor. */
export function useFlows(options?: UseFlowsOptions): UseFlowsResult {
  const base = options?.baseUrl ?? `${backendBase()}/flows`;
  const intervalMs = options?.intervalMs ?? 8000;
  const enabled = options?.enabled ?? true;
  const token = options?.token;

  const [flows, setFlows] = useState<FlowListEntry[]>([]);
  const [onlineEditing, setOnlineEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const isVisible = useDocumentVisibility();

  const af = useCallback(
    (path: string, init?: RequestInit): Promise<Response> =>
      authFetch(`${base}${path}`, token, init),
    [base, token],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: nonce is the refresh trigger; the effect body intentionally does not read it
  useEffect(() => {
    if (!enabled || !isVisible) return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await af("", { headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          flows?: FlowListEntry[];
          onlineEditing?: boolean;
        };
        if (!cancelled) {
          setFlows(data.flows ?? []);
          setOnlineEditing(data.onlineEditing ?? false);
          setError(null);
          setIsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "flows fetch failed");
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
    // The flagged "flows"/"onlineEditing" below are `data.flows`/
    // `data.onlineEditing` (from the `as { flows?: ...; onlineEditing?: ... }`
    // cast above), not the `flows`/`onlineEditing` state. @babel/eslint-parser
    // has no TypeScript type info, so exhaustive-deps' scope analysis can't
    // tell the cast's property names apart from the same-named outer bindings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [af, intervalMs, enabled, isVisible, nonce]);

  const get = useCallback(
    async (id: string): Promise<FlowDetail> => {
      const res = await af(`/${encodeURIComponent(id)}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as FlowDetail;
    },
    [af],
  );

  const validate = useCallback(
    async (def: FlowDefinition): Promise<FlowValidationReport> => {
      const res = await af("/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(def),
      });
      return (await res.json()) as FlowValidationReport;
    },
    [af],
  );

  const saveDraft = useCallback(
    async (id: string, def: FlowDefinition) => {
      const res = await af(`/${encodeURIComponent(id)}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(def),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNonce((n) => n + 1);
      return (await res.json()) as { validation: FlowValidationReport };
    },
    [af],
  );

  const publish = useCallback(
    async (id: string) => {
      const res = await af(`/${encodeURIComponent(id)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as
        | { validation: FlowValidationReport }
        | { error: { message: string }; validation?: FlowValidationReport };
      setNonce((n) => n + 1);
      if (!res.ok) {
        const e = body as {
          error: { message: string };
          validation?: FlowValidationReport;
        };
        return {
          error: e.error.message,
          ...(e.validation ? { validation: e.validation } : {}),
        };
      }
      return body as { validation: FlowValidationReport };
    },
    // The flagged "error" below is the `error` property key of this
    // function's own return object (`{ error: e.error.message, ... }`) and
    // `e.error` (an API error shape), not the `error` state — this callback
    // never reads or sets that state. @babel/eslint-parser has no TypeScript
    // type info, so exhaustive-deps' scope analysis can't tell an object
    // property key/cast property name apart from a same-named outer binding.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [af],
  );

  const remove = useCallback(
    async (id: string): Promise<boolean> => {
      const res = await af(`/${encodeURIComponent(id)}`, { method: "DELETE" });
      setNonce((n) => n + 1);
      return res.ok;
    },
    [af],
  );

  const listVersions = useCallback(
    async (id: string): Promise<FlowVersionEntry[]> => {
      const res = await af(`/${encodeURIComponent(id)}/versions`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { versions?: FlowVersionEntry[] };
      return body.versions ?? [];
    },
    [af],
  );

  const rollback = useCallback(
    async (id: string, version: number): Promise<boolean> => {
      const res = await af(`/${encodeURIComponent(id)}/rollback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version }),
      });
      setNonce((n) => n + 1);
      return res.ok;
    },
    [af],
  );

  const diff = useCallback(
    async (
      id: string,
      params?: { from?: number; to?: number; draft?: boolean },
    ): Promise<FlowDiffResponse | null> => {
      const qs = new URLSearchParams();
      if (params?.from !== undefined) qs.set("from", String(params.from));
      if (params?.to !== undefined) qs.set("to", String(params.to));
      if (params?.draft === true) qs.set("draft", "true");
      const path = `/${encodeURIComponent(id)}/diff${qs.toString() ? `?${qs.toString()}` : ""}`;
      const res = await af(path, { headers: { Accept: "application/json" } });
      if (!res.ok) return null;
      return (await res.json()) as FlowDiffResponse;
    },
    [af],
  );

  const compare = useCallback(
    async (params: {
      from: string;
      fromDraft?: string;
      to: string;
      toDraft?: string;
    }): Promise<FlowDiffResponse> => {
      const qs = new URLSearchParams();
      qs.set("from", params.from);
      if (params.fromDraft !== undefined && params.fromDraft !== "")
        qs.set("fromDraft", params.fromDraft);
      qs.set("to", params.to);
      if (params.toDraft !== undefined && params.toDraft !== "")
        qs.set("toDraft", params.toDraft);
      const res = await af(`/diff/compare?${qs.toString()}`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(body?.error?.message ?? `HTTP ${res.status}`);
      }
      return (await res.json()) as FlowDiffResponse;
    },
    [af],
  );

  return {
    flows,
    onlineEditing,
    isLoading,
    error,
    refresh,
    get,
    validate,
    saveDraft,
    publish,
    remove,
    listVersions,
    rollback,
    diff,
    compare,
  };
}
