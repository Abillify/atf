// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Backend access of the StudioBuilder (Req 9.2, Task 13.4).
 *
 * Split out of `components/StudioBuilder.tsx` so the component stays below
 * the 600-line limit (Req 9.3). All calls go through `lib/control-api`;
 * errors read from the responses are returned as `{ ok: false, error }`,
 * never thrown; the behavior is unchanged compared with the original
 * implementation.
 */

import type {
  FlowDefinition,
  FlowDraftInfo,
  FlowValidationReport,
} from "../types/flow";
import { request } from "./control-api";

export type WriteSuccessResult = { ok: true; hash: string };
export type WriteFailResult = {
  ok: false;
  error: string;
  conflict?: boolean;
  reason?: string;
};
export type WriteResult = WriteSuccessResult | WriteFailResult;

export async function writeFlowToBackend(
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
    resp = await request("/flows/write", {
      method: "POST",
      target: "backend",
      token,
      headers: { "Content-Type": "application/json" },
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

/** Which revision of the flow the canvas was loaded from. */
export type LoadedKind =
  | { kind: "new" }
  | { kind: "file" }
  | { kind: "draft"; version: number; draftId: string }
  | { kind: "published"; version: number };

export async function fetchFlowDefinition(
  token: string | null,
  flowId: string,
): Promise<{
  definition: FlowDefinition;
  hash?: string;
  kind: LoadedKind;
  format?: "yaml" | "json";
  /** The live (published) definition, when the flow has one. */
  published: FlowDefinition | null;
  /** All named drafts (default first), with definitions. */
  drafts: FlowDraftInfo[];
  /** Stored version counter of the online flow. */
  version: number;
} | null> {
  try {
    const resp = await request(`/flows/${encodeURIComponent(flowId)}`, {
      target: "backend",
      token,
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      source?: "file" | "online";
      version?: number;
      published?: FlowDefinition | null;
      draft?: FlowDefinition | null;
      drafts?: FlowDraftInfo[];
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
      ? { kind: "draft", version: data.version ?? 0, draftId: DEFAULT_DRAFT_ID }
      : data.source === "online"
        ? { kind: "published", version: data.version ?? 0 }
        : { kind: "file" };
    return {
      definition: def,
      kind,
      published: data.published ?? null,
      drafts: data.drafts ?? [],
      version: data.version ?? 0,
      ...(data.hash !== undefined ? { hash: data.hash } : {}),
      ...(data.file ? { format: data.file.format } : {}),
    };
  } catch {
    return null;
  }
}

/** The id of the implicit working draft — mirrors the runtime's DEFAULT_DRAFT_ID. */
export const DEFAULT_DRAFT_ID = "default";

export type StoreResult =
  | { ok: true; validation?: FlowValidationReport; version?: number }
  | { ok: false; error: string; validation?: FlowValidationReport };

export async function readStoreError(resp: Response): Promise<{
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

/**
 * PUT /flows/:id/draft (or /drafts/:draftId) — stores a WIP draft; the live
 * flow is untouched. The default draft keeps the classic URL.
 */
export async function saveDraftToBackend(
  token: string | null,
  definition: FlowDefinition,
  draftId: string = DEFAULT_DRAFT_ID,
  label?: string,
): Promise<StoreResult> {
  const path =
    draftId === DEFAULT_DRAFT_ID
      ? `/flows/${encodeURIComponent(definition.id)}/draft`
      : `/flows/${encodeURIComponent(definition.id)}/drafts/${encodeURIComponent(draftId)}`;
  try {
    const resp = await request(path, {
      method: "PUT",
      target: "backend",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(label !== undefined ? { ...definition, label } : definition),
    });
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
export async function publishOnBackend(
  token: string | null,
  flowId: string,
  draftId: string = DEFAULT_DRAFT_ID,
): Promise<StoreResult> {
  try {
    const resp = await request(
      `/flows/${encodeURIComponent(flowId)}/publish`,
      {
        method: "POST",
        target: "backend",
        token,
        // A JSON body (even empty): a body-less POST counts as a form post for
        // the runtime's CSRF check and is refused unless strictly same-origin.
        headers: { "Content-Type": "application/json" },
        body: draftId === DEFAULT_DRAFT_ID ? "{}" : JSON.stringify({ draftId }),
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

/** DELETE /flows/:id/drafts/:draftId — removes one named draft. */
export async function deleteDraftOnBackend(
  token: string | null,
  flowId: string,
  draftId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const resp = await request(
      `/flows/${encodeURIComponent(flowId)}/drafts/${encodeURIComponent(draftId)}`,
      {
        method: "DELETE",
        target: "backend",
        token,
      },
    );
    if (!resp.ok) return { ok: false, ...(await readStoreError(resp)) };
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Canonical form for dirty tracking — pan/zoom alone is not an edit. */
export function snapshotOf(def: FlowDefinition): string {
  const ui = def.metadata?.ui;
  const layoutOnly = ui ? { ...ui, viewport: undefined } : undefined;
  return JSON.stringify({
    ...def,
    metadata: { ...def.metadata, ui: layoutOnly },
  });
}

export async function validateFlowOnBackend(
  token: string | null,
  definition: FlowDefinition,
): Promise<FlowValidationReport | null> {
  try {
    const resp = await request("/flows/validate", {
      method: "POST",
      target: "backend",
      token,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(definition),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as FlowValidationReport;
  } catch {
    return null;
  }
}

/**
 * Formula previews in the variables table: evaluated by the Runtime so the
 * result matches exactly that of a flow run (Task 13.4).
 */
export async function evaluateFlowVariables(
  token: string | undefined,
  variables: Record<string, unknown>,
): Promise<{
  values: Record<string, unknown>;
  errors: Array<{ name: string; message: string }>;
}> {
  const resp = await request("/flows/variables/evaluate", {
    method: "POST",
    target: "backend",
    token,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ variables }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json()) as {
    values: Record<string, unknown>;
    errors: Array<{ name: string; message: string }>;
  };
}
