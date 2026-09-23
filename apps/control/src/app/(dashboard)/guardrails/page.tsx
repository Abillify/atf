"use client";
// SPDX-License-Identifier: Elastic-2.0
// SPDX-FileCopyrightText: 2026 Abillify Technology GmbH

/**
 * /guardrails — Guardrail Policy view (Req. 13.5).
 *
 * Read-only view of the per-flow guardrail policy (`guardrails.json`/`.yaml`
 * in FLOWS_DIR) via GET /admin/guardrails. Policy authoring stays file-based
 * (hot-reloaded like other flows-dir config); this page just shows what's
 * currently active.
 */

import React from "react";
import { useAuth } from "../../../lib/auth/useAuth";
import { useQuery } from "@tanstack/react-query";
import { backendUrl } from "../../../lib/backend-url";
import { authFetch } from "../../../lib/auth-fetch";

interface GuardrailSection {
  enabled?: boolean;
  mode?: string;
  threshold?: number;
  redactPii?: boolean;
  piiTypes?: string[];
  blockedPatterns?: string[];
}

interface GuardrailRule {
  id: string;
  flow: string;
  input?: GuardrailSection;
  output?: GuardrailSection;
  egress?: GuardrailSection;
}

interface GuardrailsResponse {
  hasPolicy: boolean;
  rules: GuardrailRule[];
}

function fetchGuardrails(
  token: string | undefined,
): Promise<GuardrailsResponse> {
  return authFetch(backendUrl("/admin/guardrails"), token).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json() as Promise<GuardrailsResponse>;
  });
}

function SectionBadge({
  label,
  section,
}: {
  label: string;
  section?: GuardrailSection;
}) {
  if (!section) return null;
  const disabled = section.enabled === false;
  return (
    <div
      className={`rounded-md border px-2 py-1 text-xs ${
        disabled
          ? "border-border bg-muted text-muted-foreground"
          : "border-accent/30 bg-accent/10 text-accent"
      }`}
    >
      <span className="font-medium">{label}</span>
      {disabled && <span className="ml-1">(disabled)</span>}
      {!disabled && section.mode && (
        <span className="ml-1 text-accent">mode: {section.mode}</span>
      )}
      {!disabled && section.threshold !== undefined && (
        <span className="ml-1 text-accent">
          threshold: {section.threshold}
        </span>
      )}
      {!disabled && section.redactPii && (
        <span className="ml-1 text-accent">redacts PII</span>
      )}
    </div>
  );
}

export default function GuardrailsPage() {
  // isAuthenticated (= !authRequired || !!token) statt !!token, damit die Seite
  // auch bei deaktivierter Operator-Auth (AUTHN_MODE=disabled) laedt: dann wird
  // kein Token ausgestellt, aber das Backend bedient die Operator-Plane anonym.
  // authFetch laesst den Authorization-Header bei undefined-Token weg.
  const { token, ready, isAuthenticated } = useAuth();

  const { data, isLoading, error } = useQuery<GuardrailsResponse, Error>({
    queryKey: ["guardrails"],
    queryFn: () => fetchGuardrails(token),
    enabled: ready && isAuthenticated,
  });

  return (
    <div className="mx-auto w-full max-w-screen-2xl p-4 sm:p-6">
      <h1 className="mb-4 text-xl font-semibold text-foreground">
        Guardrail Policy
      </h1>

      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          aria-busy="true"
        >
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          Loading policy…
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 p-4 text-sm text-red-700"
        >
          Failed to load guardrails: {error.message}
        </div>
      )}

      {!isLoading && !error && data && !data.hasPolicy && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          No guardrails.yaml found. Create one in FLOWS_DIR to configure
          per-flow input/output/egress guardrail overrides.
        </div>
      )}

      {!isLoading && !error && data?.hasPolicy && data.rules.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card py-12 text-center text-muted-foreground">
          Policy loaded but has no rules.
        </div>
      )}

      <div className="space-y-2">
        {data?.rules.map((rule) => (
          <div
            key={rule.id}
            className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm"
          >
            <div className="mb-2 font-mono text-sm text-foreground">
              {rule.flow === "*" ? "* (all flows)" : rule.flow}
            </div>
            <div className="flex flex-wrap gap-2">
              <SectionBadge label="input" section={rule.input} />
              <SectionBadge label="output" section={rule.output} />
              <SectionBadge label="egress" section={rule.egress} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
