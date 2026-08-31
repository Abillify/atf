// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * Flow ↔ MCP-server identity audit (`src/graph/flow-identity-audit.ts`)
 *
 * Reports flows that process personal data through MCP tool servers which
 * receive **no caller identity at all** — so any per-user or per-tenant access
 * control on the far side cannot apply.
 *
 * Why this check exists
 * ─────────────────────
 * A downstream server can only enforce a per-user ACL if it learns who the user
 * is. aiperator has two ways to tell it:
 *
 *   1. `forwardAuthToken: true` — the caller's own verified bearer is forwarded
 *      as `Authorization`. The server verifies it itself, so the identity is
 *      *proven*.
 *   2. `injectedParams` containing an identity placeholder (`{{ctx.userId}}`,
 *      `{{ctx.userEmail}}`, `{{ctx.clientId}}`) — the identity travels as a
 *      tool argument that aiperator fills in. The server has to trust
 *      aiperator's assertion, so it is *claimed* rather than proven, but it is
 *      still an identity.
 *
 * With neither, the server sees an anonymous service call. Whatever ACL it has
 * then either denies everything or — far more commonly, because that is the
 * usable default — treats the caller as a service context and returns
 * everything. This is not hypothetical: it is exactly the state vectorsearch was
 * in until 2026-08-02, and it made both of its ACL layers inert on the path
 * aiperator actually uses.
 *
 * The remaining protection in that situation is whatever filter the FLOW chooses
 * to send (a tag, a collection, a client id). That is a correctness property of
 * the flow's own logic, not an enforced boundary: a misclassification reaches
 * data it should not. Naming that difference is the whole point of this audit.
 *
 * Scope and honesty about it
 * ──────────────────────────
 * This is a **configuration** audit, not a data-access audit. It can tell that
 * no identity is conveyed; it cannot tell whether the far side would have
 * enforced anything if one were, nor whether the documents carry ACLs at all.
 * So it reports and never blocks: a false alarm here (a genuinely public
 * corpus) must not stop a deployment.
 */

import type { DataClass, FlowDefinition } from "../types/flow.js";
import type { McpServerConfig } from "../config/schema.js";

/** Data classes for which an unidentified tool call is worth reporting. */
export const IDENTITY_SENSITIVE_CLASSES: readonly DataClass[] = [
  "personal",
  "sensitive",
];

/** How (or whether) a server learns who the caller is. */
export type IdentityConveyance =
  /** Caller's verified bearer is forwarded — the server can verify it itself. */
  | "forwarded-token"
  /** Identity travels as a tool argument aiperator fills in; asserted, not proven. */
  | "asserted-param"
  /** Nothing identifies the caller. */
  | "none";

/** Placeholders in `injectedParams` that carry a caller identity. */
const IDENTITY_PLACEHOLDERS = [
  "{{ctx.userId}}",
  "{{ctx.userEmail}}",
  "{{ctx.userName}}",
  "{{ctx.clientId}}",
];

/** True when any (possibly nested) value contains an identity placeholder. */
function containsIdentityPlaceholder(value: unknown, depth = 0): boolean {
  if (depth > 8) return false; // bounded: config is small, cycles are not our problem
  if (typeof value === "string") {
    return IDENTITY_PLACEHOLDERS.some((p) => value.includes(p));
  }
  if (Array.isArray(value)) {
    return value.some((v) => containsIdentityPlaceholder(v, depth + 1));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsIdentityPlaceholder(v, depth + 1),
    );
  }
  return false;
}

/** Classify how a server learns the caller's identity. */
export function classifyIdentityConveyance(
  server: Pick<McpServerConfig, "forwardAuthToken" | "injectedParams">,
): IdentityConveyance {
  if (server.forwardAuthToken === true) return "forwarded-token";
  if (
    server.injectedParams !== undefined &&
    containsIdentityPlaceholder(server.injectedParams)
  ) {
    return "asserted-param";
  }
  return "none";
}

/**
 * Extract the MCP server names a flow's nodes reference.
 *
 * Tool refs are `"<server>/<tool>"`. Conditional per-branch overrides
 * (`FlowNode.conditions[].tools`) are included, because a branch that only
 * triggers sometimes still reaches the data when it does.
 */
export function referencedMcpServers(flow: FlowDefinition): string[] {
  const names = new Set<string>();
  const add = (refs: string[] | undefined): void => {
    for (const ref of refs ?? []) {
      const slash = ref.indexOf("/");
      if (slash > 0) names.add(ref.slice(0, slash));
    }
  };
  for (const node of flow.nodes) {
    add(node.tools);
    const conditions = (node as { conditions?: { tools?: string[] }[] }).conditions;
    for (const cond of conditions ?? []) add(cond.tools);
  }
  return [...names].sort();
}

export interface IdentityAuditFinding {
  flowId: string;
  /** The identity-sensitive classes this flow declared. */
  dataClasses: DataClass[];
  /** Referenced servers that convey no caller identity whatsoever. */
  unidentifiedServers: string[];
  /** Referenced servers that assert (rather than prove) the identity. */
  assertedServers: string[];
  /** Referenced server names not found in the MCP configuration. */
  unknownServers: string[];
}

/**
 * Audit every flow that declares an identity-sensitive data class against the
 * MCP server configuration.
 *
 * Flows without such a declaration are skipped — not because they are safe, but
 * because this audit is built on the flow author's own statement about the data
 * (the same declaration `dataRules` uses). A flow that processes personal data
 * without declaring it is a different finding, caught by the shipped-flows
 * declaration guard.
 */
export function auditFlowIdentityForwarding(
  flows: Iterable<FlowDefinition>,
  mcpServers: readonly McpServerConfig[],
): IdentityAuditFinding[] {
  const byName = new Map(mcpServers.map((s) => [s.name, s]));
  const findings: IdentityAuditFinding[] = [];

  for (const flow of flows) {
    const sensitive = (flow.dataClasses ?? []).filter((c) =>
      IDENTITY_SENSITIVE_CLASSES.includes(c),
    );
    if (sensitive.length === 0) continue;

    const unidentified: string[] = [];
    const asserted: string[] = [];
    const unknown: string[] = [];

    for (const name of referencedMcpServers(flow)) {
      const server = byName.get(name);
      if (server === undefined) {
        unknown.push(name);
        continue;
      }
      const conveyance = classifyIdentityConveyance(server);
      if (conveyance === "none") unidentified.push(name);
      else if (conveyance === "asserted-param") asserted.push(name);
    }

    if (unidentified.length === 0 && asserted.length === 0 && unknown.length === 0) {
      continue;
    }
    findings.push({
      flowId: flow.id,
      dataClasses: sensitive,
      unidentifiedServers: unidentified,
      assertedServers: asserted,
      unknownServers: unknown,
    });
  }

  findings.sort((a, b) => a.flowId.localeCompare(b.flowId));
  return findings;
}

/**
 * Render findings as operator-facing warning lines.
 *
 * Only `unidentifiedServers` produces a warning: that is the case where no ACL
 * on the far side can apply. `assertedServers` and `unknownServers` are carried
 * on the finding for diagnostics but are deliberately NOT warned about —
 * argument-asserted identity is a legitimate, documented model, and an unknown
 * server name is already a startup error elsewhere. Warning about either would
 * train operators to ignore this check.
 */
export function formatIdentityAuditWarnings(
  findings: readonly IdentityAuditFinding[],
): string[] {
  const out: string[] = [];
  for (const f of findings) {
    if (f.unidentifiedServers.length === 0) continue;
    out.push(
      `Flow '${f.flowId}' declares dataClasses [${f.dataClasses.join(", ")}] but calls MCP ` +
        `server(s) [${f.unidentifiedServers.join(", ")}] without forwarding or asserting the ` +
        `caller's identity. Those servers see an anonymous service call, so any per-user or ` +
        `per-tenant ACL they implement cannot apply — the only remaining separation is the ` +
        `filter this flow chooses to send, which is flow logic rather than an enforced ` +
        `boundary. Set forwardAuthToken: true on the server (preferred: the bearer is verified ` +
        `by the server itself), or inject {{ctx.userId}}/{{ctx.clientId}} via injectedParams.`,
    );
  }
  return out;
}
