// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Req 9.3: extracted from AssistantsPanel.tsx: wire types and shared
 * helpers (detailPath, PAGE_SIZE, readJson) of the operator surface for the
 * assistant estate. Taken over verbatim, without behavior change.
 */

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type AssistantStatus = "active" | "suspended" | "archived";
export type Autonomy = "supervised" | "assisted" | "autonomous";

export interface AssistantRow {
  tenantId: string;
  userId: string;
  assistantId: string;
  displayName?: string;
  status: AssistantStatus;
  autonomy: Autonomy;
  updatedAt: string;
  lastActiveAt?: string;
  skillCount: number;
  pendingProposalCount: number;
}

export interface AssistantListPage {
  total: number;
  assistants: AssistantRow[];
}

/**
 * Operator constraints as the API returns them.
 *
 * `deniedTools` is a list, not prose: it is enforced by the tool-authz layer, and the
 * prompt copy exists only so the model knows why a tool is absent instead of
 * repeatedly attempting it.
 */
export interface ConstraintsView {
  rules?: string;
  compliance?: string;
  deniedTools?: string[];
}

export interface SoulView {
  identity: Record<string, string>;
  directives: Record<string, string>;
  constraints: ConstraintsView;
  revision: number;
  revisionHash: string;
}

export interface AssistantDetail {
  tenantId: string;
  userId: string;
  assistantId: string;
  displayName?: string;
  status: AssistantStatus;
  autonomy: Autonomy;
  workspacePath: string;
  createdAt: string;
  lastActiveAt?: string;
  soul: SoulView;
  skills: {
    name: string;
    triggerLine: string;
    origin: string;
    status: string;
    version: number;
    useCount: number;
  }[];
  delegations: DelegationView[];
}

export interface DelegationView {
  issuer: string;
  consentedScope: string;
  state: string;
}

export interface ProposalRow {
  id: string;
  kind: string;
  status: string;
  title?: string;
  triggerLine?: string;
  body?: string;
  autonomousCapture: boolean;
  scanState: string;
  scanFindings?: string[];
  createdAt: string;
}

/** Path segment for one assistant. All three parts are named explicitly. */
export function detailPath(row: {
  tenantId: string;
  userId: string;
  assistantId: string;
}): string {
  return [
    encodeURIComponent(row.tenantId),
    encodeURIComponent(row.userId),
    encodeURIComponent(row.assistantId),
  ].join("/");
}

export const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Fetchers
// ---------------------------------------------------------------------------

export async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    // The body carries the reason the backend refused; surfacing "HTTP 409" alone
    // would leave an operator guessing whether to retry.
    const detail = await response
      .json()
      .then((body: unknown) =>
        typeof body === "object" && body !== null && "error" in body
          ? String((body as { error: { message?: string } }).error?.message ?? "")
          : "",
      )
      .catch(() => "");
    throw new Error(detail !== "" ? detail : `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}
